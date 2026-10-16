import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { runWindowsSessionProbe } from "./active-agent-sessions.mjs";
import { collectClaudeHistory, collectClaudeHistoryForProject, revalidateClaudeHistoryCandidate } from "./claude-session-history.mjs";
import { matchSessionName } from "./session-name-match.mjs";
import {
  canonicalProjectDirectory,
  finalizeProjectDisplays,
  isExcludedProject,
  matchProjects,
  projectFromPath,
  projectKey,
} from "./project-policy.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUSY_GATEWAY = new Set(["queued", "running", "waiting_approval"]);

function ordinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function samePath(left, right) {
  return path.resolve(left).replaceAll("/", "\\").toLowerCase()
    === path.resolve(right).replaceAll("/", "\\").toLowerCase();
}

async function highestDatabase(root, family) {
  let entries;
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const pattern = new RegExp(`^${family}_(\\d+)\\.sqlite$`, "i");
  return entries.flatMap((entry) => {
    const match = entry.isFile() && entry.name.match(pattern);
    return match ? [{ generation: Number(match[1]), filePath: path.join(root, entry.name) }] : [];
  }).sort((left, right) => right.generation - left.generation || ordinal(left.filePath, right.filePath))[0] || null;
}

function runWorker(workerData, timeoutMs = 4000, WorkerImpl = Worker) {
  return new Promise((resolve, reject) => {
    const worker = new WorkerImpl(new URL("./active-agent-codex-worker.mjs", import.meta.url), { workerData, execArgv: [] });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      worker.terminate();
      finish(Object.assign(new Error("Codex catalog timed out"), { code: "ETIMEDOUT" }));
    }, timeoutMs);
    timer.unref?.();
    worker.once("message", (message) => finish(message?.ok ? null : new Error(message?.error || "Codex catalog failed"), message));
    worker.once("error", (error) => finish(error));
    worker.once("exit", (code) => { if (!settled && code !== 0) finish(new Error(`Codex catalog worker exited with ${code}`)); });
  });
}

async function readCodexIndex(indexPath) {
  let stat;
  try { stat = await fsp.lstat(indexPath); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error("Codex session index is unsafe or too large");
  const text = await fsp.readFile(indexPath, "utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length > 20000 || lines.some((line) => Buffer.byteLength(line) > 65536)) throw new Error("Codex session index exceeds limits");
  const newest = new Map();
  for (const line of lines) {
    let payload;
    try { payload = JSON.parse(line); } catch { throw new Error("Codex session index is malformed"); }
    const id = String(payload.id || "").toLowerCase();
    if (!UUID_PATTERN.test(id) || typeof payload.thread_name !== "string") throw new Error("Codex session index row is invalid");
    const updatedAt = Date.parse(payload.updated_at || "") || 0;
    const prior = newest.get(id);
    if (!prior || updatedAt >= prior.updatedAt) newest.set(id, { id, name: payload.thread_name, updatedAt });
  }
  return [...newest.values()];
}

export async function collectCodexHistory({ codexRoot, timeoutMs = 4000, WorkerImpl = Worker }) {
  const indexPath = path.join(codexRoot, "session_index.jsonl");
  const [indexEntries, state, history] = await Promise.all([
    readCodexIndex(indexPath),
    highestDatabase(codexRoot, "state"),
    highestDatabase(codexRoot, "thread_history"),
  ]);
  if (!indexEntries && !state && !history) return { records: [], complete: true };
  if (!indexEntries || !state || !history) return { records: [], complete: false, reason: "codex_sources_incomplete" };
  const result = await runWorker({
    mode: "catalog",
    historyPath: history.filePath,
    statePath: state.filePath,
    indexEntries,
  }, timeoutMs, WorkerImpl);
  return {
    complete: true,
    records: result.records.map((record) => ({
      ...record,
      statePath: state.filePath,
      projectVerified: false,
      capability: record.latestTurn?.status === "inProgress" ? "busy" : "ready",
      busy: record.latestTurn?.status === "inProgress",
      lockPath: path.join(codexRoot, "thread-writer-locks", `${record.nativeId}.lock`),
    })),
  };
}

async function collectClaudeLiveOwners({ claudeRoot, probe = runWindowsSessionProbe }) {
  const sessionsRoot = path.join(claudeRoot, "sessions");
  let entries;
  try { entries = await fsp.readdir(sessionsRoot, { withFileTypes: true }); } catch (error) {
    if (error.code === "ENOENT") return new Set();
    throw error;
  }
  if (entries.length > 1024) throw new Error("Claude live registry exceeds limits");
  const processes = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;
    const filePath = path.join(sessionsRoot, entry.name);
    const stat = await fsp.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 65536) throw new Error("Claude live registry is invalid");
    let payload;
    try { payload = JSON.parse(await fsp.readFile(filePath, "utf8")); } catch { continue; }
    const id = String(payload.sessionId || "").toLowerCase();
    const pid = Number(payload.pid);
    const procStart = String(payload.procStart || "");
    if (!UUID_PATTERN.test(id) || !Number.isSafeInteger(pid) || pid <= 0 || !/^\d{10,20}$/.test(procStart)) continue;
    processes.push({ id, pid, procStart });
  }
  if (!processes.length) return new Set();
  const result = await probe({ locks: [], processes });
  return new Set(processes.filter((item) => result.processes.get(item.id)?.state === "live").map((item) => item.id));
}

function buildProjects(config, records) {
  const groups = new Map();
  const add = (projectPath, authority, updatedAt = null) => {
    if (!projectPath) return;
    let project;
    try { project = projectFromPath(config, projectPath, authority ? [authority] : [], updatedAt); } catch { return; }
    if (!project) return;
    const prior = groups.get(project.key) || { project, authorities: [], updatedAt: 0 };
    if (authority && !prior.authorities.some((item) => JSON.stringify(item) === JSON.stringify(authority))) prior.authorities.push(authority);
    prior.updatedAt = Math.max(prior.updatedAt, Number(updatedAt || 0));
    groups.set(project.key, prior);
  };
  for (const override of config.projects || []) add(override.path, {
    sourceType: "override",
    provider: null,
    nativeId: null,
    sourcePath: null,
    overrideAlias: override.alias,
  });
  for (const record of records) {
    if (record.provider === "gateway" || !record.projectPath || !record.authority) continue;
    add(record.projectPath, record.authority, record.updatedAt);
  }
  const projects = [...groups.values()].map(({ project, authorities, updatedAt }) => Object.freeze({
    ...project,
    authorities: Object.freeze(authorities.map((item) => Object.freeze({ ...item }))),
    updatedAt: updatedAt || project.updatedAt,
  })).sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0) || ordinal(left.key, right.key));
  return finalizeProjectDisplays(projects);
}

function mergeCatalogRecords(records, projects) {
  const projectByKey = new Map(projects.map((project) => [project.key, project]));
  const projectForPath = (value) => {
    if (!value) return null;
    try { return projectByKey.get(projectKey(canonicalProjectDirectory(value))) || null; } catch { return null; }
  };
  const groups = new Map();
  for (const record of records) {
    const executor = record.executor;
    const nativeId = record.nativeId ? String(record.nativeId).toLowerCase() : null;
    const key = nativeId ? `${executor}:${nativeId}` : `gateway:${record.gatewayId}`;
    const group = groups.get(key) || [];
    group.push(record);
    groups.set(key, group);
  }
  const merged = [];
  for (const [identity, group] of groups) {
    const gateways = group.filter((item) => item.provider === "gateway");
    const natives = group.filter((item) => item.provider !== "gateway");
    const gateway = gateways.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))[0] || null;
    const native = natives.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))[0] || null;
    const nativeProject = projectForPath(native?.cwd || native?.projectPath);
    const gatewayProject = projectForPath(gateway?.projectPath);
    const project = nativeProject || gatewayProject;
    const aliases = [...new Set(group.flatMap((item) => [item.name, ...(item.aliases || [])]).filter(Boolean))];
    const conflict = gateways.length > 1 || !project
      || (gateway && native?.cwd && !samePath(gateway.projectPath, native.cwd));
    if (!gateway && !native?.name) continue;
    merged.push({
      ...(native || {}),
      ...(gateway || {}),
      identity,
      provider: gateway && native ? `gateway+${native.provider}` : gateway?.provider || native?.provider,
      executor: gateway?.executor || native?.executor,
      gatewayId: gateway?.gatewayId || null,
      nativeId: gateway?.nativeId || native?.nativeId || null,
      name: gateway?.name || native?.name,
      nativeName: native?.name || null,
      aliases,
      projectAlias: project?.alias || null,
      projectDisplay: project?.display || null,
      projectPath: project?.path || null,
      project,
      authority: native?.authority || project?.authorities?.[0] || null,
      updatedAt: Math.max(...group.map((item) => Number(item.updatedAt || 0))) || null,
      busy: group.some((item) => item.busy || BUSY_GATEWAY.has(item.status)),
      capability: conflict ? "identity_conflict" : group.some((item) => item.capability === "project_unverified") ? "project_unverified" : "ready",
    });
  }
  return merged;
}

export async function buildSessionCatalog({
  config,
  store,
  executor = null,
  project = null,
  codexRoot = path.join(os.homedir(), ".codex"),
  claudeRoot = path.join(os.homedir(), ".claude"),
  collectCodex = collectCodexHistory,
  collectClaudeProject = collectClaudeHistoryForProject,
  collectClaude = collectClaudeHistory,
  collectClaudeOwners = collectClaudeLiveOwners,
  projectQuery = null,
  requireAllProjects = false,
} = {}) {
  const gatewayRows = store.listSessionsBounded ? store.listSessionsBounded(20000) : { records: store.listSessions(200), complete: true };
  const records = gatewayRows.records.map((session) => ({
    provider: "gateway",
    executor: session.executor,
    gatewayId: session.id,
    sessionId: session.id,
    nativeId: session.native_id ? String(session.native_id).toLowerCase() : null,
    name: session.name,
    aliases: [],
    projectAlias: session.project_alias,
    projectPath: session.project_path,
    cwd: session.project_path,
    status: session.status,
    busy: BUSY_GATEWAY.has(session.status),
    updatedAt: session.updated_at,
  }));
  const completeness = { gateway: gatewayRows.complete, codex: true, claude: true };
  const effectiveExecutor = projectQuery || requireAllProjects ? null : executor;

  if (!effectiveExecutor || effectiveExecutor === "codex") {
    try {
      const result = await collectCodex({ codexRoot });
      completeness.codex = result.complete;
      for (const record of result.records) {
        let project = null;
        try {
          if (record.cwd) {
            const canonical = canonicalProjectDirectory(record.cwd);
            if (!isExcludedProject(config, canonical)) project = projectFromPath(config, canonical, [{
              sourceType: "native",
              provider: "codex",
              nativeId: record.nativeId,
              sourcePath: record.statePath || null,
            }], record.updatedAt);
          }
        } catch {}
        records.push({
          ...record,
          projectAlias: project?.alias || null,
          projectPath: project?.path || null,
          project,
          authority: project?.authorities?.[0] || null,
          projectVerified: Boolean(project),
          capability: project ? record.capability : "project_unverified",
        });
      }
    } catch {
      completeness.codex = false;
    }
  }

  if (!effectiveExecutor || effectiveExecutor === "claude") {
    let owners = new Set();
    try { owners = await collectClaudeOwners({ claudeRoot }); } catch { completeness.claude = false; }
    try {
      const result = project && !projectQuery
        ? await collectClaudeProject({ claudeRoot, project })
        : await collectClaude({ claudeRoot, config });
      completeness.claude = completeness.claude && result.complete;
      records.push(...result.records.map((record) => ({
        ...record,
        busy: owners.has(record.nativeId),
        capability: owners.has(record.nativeId) ? "busy" : record.capability,
      })));
    } catch {
      completeness.claude = false;
    }
  }

  const projects = buildProjects(config, records);
  let candidates = mergeCatalogRecords(records, projects);
  if (executor) candidates = candidates.filter((item) => item.executor === executor);
  if (project) candidates = candidates.filter((item) => item.projectPath && samePath(item.projectPath, project.path));
  const projectMatch = matchProjects(projectQuery, projects);
  if (projectQuery && projectMatch.kind === "selected") {
    candidates = candidates.filter((item) => item.projectPath && samePath(item.projectPath, projectMatch.project.path));
  } else if (projectQuery) {
    candidates = [];
  }
  const complete = completeness.gateway && (projectQuery || requireAllProjects
    ? completeness.codex && completeness.claude
    : executor ? completeness[executor] : completeness.codex && completeness.claude);
  return { candidates, projects, projectMatch, complete, completeness };
}

export async function findNamedSession(options) {
  const catalog = await buildSessionCatalog(options);
  return { ...catalog, match: matchSessionName(options.sessionName, catalog.candidates) };
}

export async function revalidateNativeCandidate(candidate, {
  config = { excludedRoots: [] },
  codexRoot = path.join(os.homedir(), ".codex"),
  claudeRoot = path.join(os.homedir(), ".claude"),
  probe = runWindowsSessionProbe,
  collectCodex = collectCodexHistory,
} = {}) {
  if (!candidate?.nativeId) return { ok: true };
  if (candidate.executor === "claude") {
    const exact = await revalidateClaudeHistoryCandidate(candidate);
    if (!exact.ok) return exact;
    if (isExcludedProject(config, candidate.projectPath)) {
      return { ok: false, reason: "project_excluded" };
    }
    let owners;
    try { owners = await collectClaudeLiveOwners({ claudeRoot, probe }); } catch { return { ok: false, reason: "snapshot_incomplete" }; }
    return owners.has(candidate.nativeId) ? { ok: false, reason: "busy" } : { ok: true };
  }
  let result;
  try { result = await collectCodex({ codexRoot }); } catch { return { ok: false, reason: "snapshot_incomplete" }; }
  if (!result.complete) return { ok: false, reason: "snapshot_incomplete" };
  const current = result.records.find((item) => item.nativeId === candidate.nativeId);
  let currentProject;
  try { currentProject = current?.cwd ? canonicalProjectDirectory(current.cwd) : null; } catch { currentProject = null; }
  if (!currentProject || !samePath(currentProject, candidate.projectPath)) return { ok: false, reason: "stale_target" };
  if (isExcludedProject(config, currentProject)) return { ok: false, reason: "project_excluded" };
  if (current.latestTurn?.status === "inProgress") return { ok: false, reason: "busy" };
  try {
    const lock = await probe({ locks: [{ id: current.nativeId, path: current.lockPath }], processes: [] });
    const state = lock.locks.get(current.nativeId)?.state;
    if (state === "held") return { ok: false, reason: "busy" };
    if (!["free", "missing"].includes(state)) return { ok: false, reason: "snapshot_incomplete" };
  } catch { return { ok: false, reason: "snapshot_incomplete" }; }
  return { ok: true };
}

export async function revalidateGatewaySession(session, options) {
  if (!session?.native_id) return { ok: true };
  const catalog = await buildSessionCatalog({
    ...options,
    executor: session.executor,
  });
  if (!catalog.complete) return { ok: false, reason: "snapshot_incomplete" };
  const nativeId = String(session.native_id).toLowerCase();
  const candidate = catalog.candidates.find((item) => item.executor === session.executor && item.nativeId === nativeId);
  if (!candidate || !String(candidate.provider || "").includes(`+${session.executor}`)) {
    return { ok: false, reason: "snapshot_incomplete" };
  }
  if (!candidate.projectPath || !samePath(candidate.projectPath, session.project_path)) {
    return { ok: false, reason: "stale_target" };
  }
  if (candidate.busy) return { ok: false, reason: "busy" };
  return revalidateNativeCandidate(candidate, options);
}

