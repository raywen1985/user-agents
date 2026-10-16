import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { projectRoot } from "./config.mjs";
import { runProcess } from "./process-utils.mjs";
import { compactOneLine } from "./sanitize.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHASE_PRIORITY = { waiting_approval: 0, waiting_input: 0, running: 1, reported: 2, queued: 3 };
const TERMINAL_CLAUDE_STATES = new Set(["idle", "completed", "failed", "cancelled", "canceled", "stopped", "exited", "terminated"]);

function ordinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeId(value) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return UUID_PATTERN.test(text) ? text : null;
}

function statusPriority(status) {
  return PHASE_PRIORITY[status] ?? PHASE_PRIORITY.reported;
}

function recordOrder(left, right) {
  return statusPriority(left.status) - statusPriority(right.status)
    || Number(right.updatedAt || 0) - Number(left.updatedAt || 0)
    || ordinal(String(left.agent || ""), String(right.agent || ""))
    || ordinal(String(left.sourcePath || "").toLowerCase(), String(right.sourcePath || "").toLowerCase())
    || ordinal(String(left.sourcePath || ""), String(right.sourcePath || ""))
    || Number(left.pid ?? Number.MAX_SAFE_INTEGER) - Number(right.pid ?? Number.MAX_SAFE_INTEGER)
    || ordinal(String(left.sessionId || ""), String(right.sessionId || ""));
}

function normalizeRecord(record) {
  return {
    ...record,
    agent: record.agent === "claude" ? "claude" : "codex",
    nativeId: normalizeId(record.nativeId),
    updatedAt: Number(record.updatedAt || 0) || null,
    pid: Number.isSafeInteger(Number(record.pid)) && Number(record.pid) > 0 ? Number(record.pid) : null,
  };
}

function deduplicateNativeCandidates(records) {
  const groups = new Map();
  for (const item of records.map(normalizeRecord)) {
    if (!item.nativeId) continue;
    const key = `${item.agent}:${item.nativeId}`;
    const group = groups.get(key) || [];
    group.push(item);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => group.sort(recordOrder)[0]);
}

function withTimeout(promise, timeoutMs, onTimeout) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      onTimeout?.();
      const error = new Error(`Session provider timed out after ${timeoutMs}ms`);
      error.code = "ETIMEDOUT";
      finish(error);
    }, timeoutMs);
    timer.unref?.();
    promise.then((value) => finish(null, value), (error) => finish(error));
  });
}

export function aggregateActiveAgentRecords(records, limit = 200) {
  const normalized = records.map(normalizeRecord);
  const nativeGroups = new Map();
  const gatewayGroups = new Map();

  for (const record of normalized) {
    if (record.provider === "gateway") {
      const key = record.nativeId ? `${record.agent}:${record.nativeId}` : `gateway:${record.gatewayId || record.sessionId}`;
      const group = gatewayGroups.get(key) || [];
      group.push(record);
      gatewayGroups.set(key, group);
    } else if (record.nativeId) {
      const key = `${record.agent}:${record.nativeId}`;
      const group = nativeGroups.get(key) || [];
      group.push(record);
      nativeGroups.set(key, group);
    }
  }

  const merged = [];
  for (const [key, group] of gatewayGroups) {
    group.sort(recordOrder);
    const gateway = group[0];
    const nativeGroup = nativeGroups.get(key) || [];
    nativeGroup.sort(recordOrder);
    const native = nativeGroup[0];
    nativeGroups.delete(key);
    const gatewayIds = [...new Set(group.map((item) => item.gatewayId || item.sessionId).filter(Boolean))].sort(ordinal);
    const gatewayOwners = gatewayIds.map((gatewayId) => ({
      gatewayId,
      taskIds: [...new Set(group.filter((item) => (item.gatewayId || item.sessionId) === gatewayId)
        .map((item) => item.taskId).filter(Boolean))].sort(ordinal),
    }));
    merged.push({
      ...(native || {}),
      ...gateway,
      provider: native ? `gateway+${native.provider}` : "gateway",
      cwd: gateway.cwd || native?.cwd || null,
      pid: native?.pid || null,
      updatedAt: Math.max(Number(gateway.updatedAt || 0), Number(native?.updatedAt || 0)) || null,
      gatewayIds: gatewayIds.slice(0, 3),
      extraGatewayIds: Math.max(0, gatewayIds.length - 3),
      gatewayOwners,
    });
  }

  for (const group of nativeGroups.values()) {
    group.sort(recordOrder);
    merged.push(group[0]);
  }

  merged.sort(recordOrder);
  return { records: merged.slice(0, limit), truncated: Math.max(0, merged.length - limit) };
}

function displayAgent(record) {
  const agent = record.agent === "claude" ? "Claude" : "Codex";
  return record.provider.startsWith("gateway") ? `Gateway/${agent}` : agent;
}

export function formatActiveAgentSessions(records, warnings = [], options = {}) {
  const displayLimit = options.displayLimit ?? 30;
  const maxLength = options.maxLength ?? 12000;
  const shown = records.slice(0, displayLimit);
  const lines = shown.map((record) => {
    const name = compactOneLine(record.name || "未命名 Session", 80);
    const primaryId = record.gatewayId || record.sessionId || record.nativeId || "-";
    const location = compactOneLine(record.projectAlias || record.cwd || "未知目录", 180);
    const pid = record.pid ? ` | PID ${record.pid}` : "";
    const extra = record.extraGatewayIds ? ` | +${record.extraGatewayIds} gateway IDs` : "";
    const stop = record.stopRef ? ` | 停止ID: ${record.stopRef}`
      : record.stopCapability?.reason ? ` | 停止: 不可用 (${record.stopCapability.reason})` : "";
    return `${displayAgent(record)} | ${record.status} | ${name} | ${primaryId} | ${location}${pid}${extra}${stop}`;
  });
  const hidden = Math.max(0, records.length - shown.length) + Number(options.additionalHidden || 0);
  if (hidden) lines.push(`... 另有 ${hidden} 个活跃 Session 未显示`);
  for (const warning of warnings.slice(0, 3)) lines.push(`警告：${compactOneLine(warning, 200)}`);
  if (!shown.length) lines.unshift("当前没有正在工作的 Agent Session。");
  const text = lines.join("\n");
  return text.length > maxLength ? `${text.slice(0, maxLength - 16)}\n... 输出已截断` : text;
}

async function highestDatabase(root, family) {
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const pattern = new RegExp(`^${family}_(\\d+)\\.sqlite$`, "i");
  return entries.flatMap((entry) => {
    const match = entry.isFile() && entry.name.match(pattern);
    return match ? [{ generation: Number(match[1]), filePath: path.join(root, entry.name) }] : [];
  }).sort((left, right) => right.generation - left.generation || ordinal(left.filePath, right.filePath))[0] || null;
}

function runCodexWorker(workerData, timeoutMs, WorkerImpl = Worker) {
  return new Promise((resolve, reject) => {
    const worker = new WorkerImpl(new URL("./active-agent-codex-worker.mjs", import.meta.url), { workerData, execArgv: [] });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      worker.terminate();
      const error = new Error("Codex session query timed out");
      error.code = "ETIMEDOUT";
      finish(error);
    }, timeoutMs);
    timer.unref?.();
    worker.once("message", (message) => {
      if (!message?.ok) return finish(new Error(message?.error || "Codex worker failed"));
      finish(null, message);
    });
    worker.once("error", (error) => finish(error));
    worker.once("exit", (code) => {
      if (!settled && code !== 0) finish(new Error(`Codex worker exited with ${code}`));
    });
  });
}

export async function collectCodexCandidates({ codexRoot, timeoutMs = 4000, WorkerImpl = Worker }) {
  const history = await highestDatabase(codexRoot, "thread_history");
  const state = await highestDatabase(codexRoot, "state");
  if (!history || !state) throw new Error("Codex session databases were not found");
  const result = await runCodexWorker({ historyPath: history.filePath, statePath: state.filePath, limit: 200 }, timeoutMs, WorkerImpl);
  const records = result.records.flatMap((record) => {
    const nativeId = normalizeId(record.nativeId);
    if (!nativeId) return [];
    return [{ ...record, nativeId, sessionId: nativeId, lockPath: path.join(codexRoot, "thread-writer-locks", `${nativeId}.lock`) }];
  });
  return { records, truncated: Boolean(result.truncated) };
}

export async function collectCodexExact({ codexRoot, threadId, timeoutMs = 2000, WorkerImpl = Worker }) {
  const history = await highestDatabase(codexRoot, "thread_history");
  const state = await highestDatabase(codexRoot, "state");
  if (!history || !state) throw new Error("Codex session databases were not found");
  const result = await runCodexWorker({ historyPath: history.filePath, statePath: state.filePath, threadId }, timeoutMs, WorkerImpl);
  return result.exact || null;
}

function normalizedClaudeStatus(value) {
  return String(value || "").trim().toLowerCase().replace(/[-_\s]/g, "");
}

export async function collectClaudeCandidates({ claudeRoot, signal }) {
  const sessionsRoot = path.join(claudeRoot, "sessions");
  let entries;
  try {
    entries = await fsp.readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return { records: [], truncated: false, skipped: 0 };
    throw error;
  }
  const names = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map((entry) => path.join(sessionsRoot, entry.name));
  const stats = [];
  for (const filePath of names.slice(0, 1024)) {
    const stat = await fsp.stat(filePath);
    stats.push({ filePath, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  stats.sort((left, right) => right.mtimeMs - left.mtimeMs
    || ordinal(left.filePath.toLowerCase(), right.filePath.toLowerCase())
    || ordinal(left.filePath, right.filePath));
  const selected = stats.slice(0, 256);
  const records = [];
  let skipped = 0;
  let qualifying = 0;
  for (const file of selected) {
    if (file.size > 65536) { skipped += 1; continue; }
    let payload;
    try {
      payload = JSON.parse(await fsp.readFile(file.filePath, { encoding: "utf8", signal }));
    } catch (error) {
      if (error.name === "AbortError") throw error;
      skipped += 1;
      continue;
    }
    const nativeId = normalizeId(payload.sessionId);
    const pid = Number(payload.pid);
    const procStart = String(payload.procStart || "");
    const state = normalizedClaudeStatus(payload.status);
    if (!nativeId || !Number.isSafeInteger(pid) || pid <= 0 || !/^\d{10,20}$/.test(procStart)
      || typeof payload.cwd !== "string" || !state || TERMINAL_CLAUDE_STATES.has(state)) continue;
    qualifying += 1;
    if (records.length >= 200) continue;
    records.push({
      provider: "claude",
      agent: "claude",
      sessionId: nativeId,
      nativeId,
      name: typeof payload.name === "string" ? payload.name : null,
      status: state.includes("wait") ? "waiting_input" : state.includes("run") || state.includes("work") || state.includes("busy") ? "running" : "reported",
      cwd: payload.cwd,
      pid,
      procStart,
      updatedAt: Number(payload.updatedAt || file.mtimeMs) || file.mtimeMs,
      sourcePath: file.filePath,
    });
  }
  return {
    records,
    truncated: names.length > 256 || qualifying > 200,
    skipped,
  };
}

export async function readExactClaudeSession({ claudeRoot, sourcePath, sessionId, pid, procStart }) {
  const sourceStat = await fsp.lstat(sourcePath);
  if (sourceStat.isSymbolicLink()) return { ok: false, reason: "identity_changed" };
  const sessionsRoot = await fsp.realpath(path.join(claudeRoot, "sessions"));
  const canonical = await fsp.realpath(sourcePath);
  const relative = path.relative(sessionsRoot, canonical);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return { ok: false, reason: "identity_changed" };
  const stat = await fsp.lstat(canonical);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) return { ok: false, reason: "identity_changed" };
  let payload;
  try { payload = JSON.parse(await fsp.readFile(canonical, "utf8")); } catch { return { ok: false, reason: "snapshot_incomplete" }; }
  const state = normalizedClaudeStatus(payload.status);
  if (normalizeId(payload.sessionId) !== normalizeId(sessionId)
    || Number(payload.pid) !== Number(pid) || String(payload.procStart || "") !== String(procStart || "")) {
    return { ok: false, reason: "identity_changed" };
  }
  if (!state || TERMINAL_CLAUDE_STATES.has(state)) return { ok: false, reason: "already_finished" };
  return { ok: true, record: {
    sessionId: normalizeId(sessionId), pid: Number(pid), procStart: String(procStart), sourcePath: canonical, status: state,
  } };
}

function validateProbeResults(requests, results, label) {
  if (!Array.isArray(results) || results.length !== requests.length) throw new Error(`${label} probe result count mismatch`);
  const expected = new Set(requests.map((item) => item.id));
  const seen = new Set();
  for (const result of results) {
    if (!result || !expected.has(result.id) || seen.has(result.id)) throw new Error(`${label} probe result IDs are invalid`);
    seen.add(result.id);
  }
  return new Map(results.map((result) => [result.id, result]));
}

export async function runWindowsSessionProbe({ locks, processes, timeoutMs = 3000, env = process.env, run = runProcess }) {
  const systemRoot = env.SystemRoot || env.SYSTEMROOT;
  if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error("SystemRoot is unavailable");
  const executable = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = path.join(projectRoot, "scripts", "session-probe.ps1");
  const request = { locks, processes };
  if (locks.length + processes.length > 512) throw new Error("Too many native session probes");
  const result = await run(executable, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
  ], {
    cwd: projectRoot,
    input: JSON.stringify(request),
    timeoutMs,
    maxOutputBytes: 262144,
  });
  if (result.code !== 0 || result.stderr.trim()) throw new Error(`Windows session probe failed (${result.code})`);
  const payload = JSON.parse(result.stdout);
  return {
    locks: validateProbeResults(locks, payload.locks, "lock"),
    processes: validateProbeResults(processes, payload.processes, "process"),
  };
}

function boundedWarning(provider, error) {
  return `${provider}：${compactOneLine(error?.message || error || "查询失败", 180)}`;
}

export async function collectActiveAgentSessionRecords({
  gatewayActivities = [],
  gatewayTruncated = false,
  codexRoot = path.join(os.homedir(), ".codex"),
  claudeRoot = path.join(os.homedir(), ".claude"),
  collectCodex = collectCodexCandidates,
  collectClaude = collectClaudeCandidates,
  probe = runWindowsSessionProbe,
  totalTimeoutMs = 5000,
  aggregateLimit = 200,
  executor = null,
} = {}) {
  const started = Date.now();
  const warnings = [];
  const claudeAbort = new AbortController();
  const providerTimeout = Math.min(4000, totalTimeoutMs);
  const [codexResult, claudeResult] = await Promise.allSettled([
    executor === "claude" ? Promise.resolve({ records: [], truncated: false }) : withTimeout(
      collectCodex({ codexRoot, timeoutMs: providerTimeout }),
      providerTimeout,
    ),
    executor === "codex" ? Promise.resolve({ records: [], truncated: false, skipped: 0 }) : withTimeout(
      collectClaude({ claudeRoot, signal: claudeAbort.signal }),
      providerTimeout,
      () => claudeAbort.abort(),
    ),
  ]);
  let codex = codexResult.status === "fulfilled" ? codexResult.value : { records: [], truncated: false };
  let claude = claudeResult.status === "fulfilled" ? claudeResult.value : { records: [], truncated: false, skipped: 0 };
  const completeness = {
    gateway: !gatewayTruncated,
    codex: executor === "claude" || (codexResult.status === "fulfilled" && !codex.truncated),
    claude: executor === "codex" || (claudeResult.status === "fulfilled" && !claude.truncated && !claude.skipped),
  };
  if (codexResult.status === "rejected") warnings.push(boundedWarning("Codex", codexResult.reason));
  if (claudeResult.status === "rejected") warnings.push(boundedWarning("Claude", claudeResult.reason));
  if (codex.truncated) warnings.push("Codex：结果达到 200 条上限");
  if (claude.truncated) warnings.push("Claude：输入或结果达到上限");
  if (claude.skipped) warnings.push(`Claude：跳过 ${claude.skipped} 个无效 Session 文件`);
  if (gatewayTruncated) warnings.push("Gateway：活动队列达到 200 条上限");

  codex.records = deduplicateNativeCandidates(codex.records);
  claude.records = deduplicateNativeCandidates(claude.records);

  const locks = codex.records.map((record) => ({ id: record.nativeId, path: record.lockPath }));
  const processes = claude.records.map((record) => ({ id: record.nativeId, pid: record.pid, procStart: record.procStart }));
  if (locks.length || processes.length) {
    const remaining = Math.max(1, totalTimeoutMs - (Date.now() - started));
    try {
      const probed = await probe({ locks, processes, timeoutMs: Math.min(3000, remaining) });
      const codexProbeError = [...probed.locks.values()].find((item) => ["accessDenied", "error"].includes(item.state));
      const claudeProbeError = [...probed.processes.values()].find((item) => ["accessDenied", "error"].includes(item.state));
      if (codexProbeError) {
        codex.records = [];
        completeness.codex = false;
        warnings.push(`Codex：Windows 锁探针失败 (${codexProbeError.code ?? "unknown"})`);
      } else {
        codex.records = codex.records.filter((record) => probed.locks.get(record.nativeId)?.state === "held");
      }
      if (claudeProbeError) {
        claude.records = [];
        completeness.claude = false;
        warnings.push(`Claude：Windows 进程探针失败 (${claudeProbeError.code ?? "unknown"})`);
      } else {
        claude.records = claude.records.filter((record) => probed.processes.get(record.nativeId)?.state === "live");
      }
    } catch (error) {
      if (locks.length) { codex.records = []; completeness.codex = false; warnings.push(boundedWarning("Codex", error)); }
      if (processes.length) { claude.records = []; completeness.claude = false; warnings.push(boundedWarning("Claude", error)); }
    }
  }
  claudeAbort.abort();

  const aggregate = aggregateActiveAgentRecords([...gatewayActivities, ...codex.records, ...claude.records], aggregateLimit);
  if (aggregate.truncated) {
    completeness.gateway = false;
    completeness.codex = false;
    completeness.claude = false;
  }
  return { records: aggregate.records, warnings, additionalHidden: aggregate.truncated, completeness };
}

export async function listActiveAgentSessions(options = {}) {
  const collected = await collectActiveAgentSessionRecords(options);
  const records = options.decorateRecords ? await options.decorateRecords(collected.records) : collected.records;
  return formatActiveAgentSessions(records, collected.warnings, { additionalHidden: collected.additionalHidden });
}
