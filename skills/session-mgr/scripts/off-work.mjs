import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from './discovery/process-utils.mjs';
import { runWindowsSessionProbe } from './discovery/active-agent-sessions.mjs';

const key = value => String(value || '').replaceAll('/', '\\').replace(/^\\\\\?\\/, '').toLowerCase();
const validIdentity = row => Number.isSafeInteger(row.pid) && row.pid > 0
  && /^\d{10,20}$/.test(row.procStart || '') && path.win32.isAbsolute(row.executable || '') && Boolean(row.ownerSid);
const scriptDirectory = fileURLToPath(new URL('.', import.meta.url));

// Inspect only the executable or actual script entry, never arbitrary prompt arguments.
export function processEntry(row) {
  const args = String(row.commandLine || '').match(/"[^"]*"|[^\s]+/g) || [];
  return args.slice(0, 2).map(arg => key(arg.replace(/^"|"$/g, '')));
}

export function identifyAgentProcess(row) {
  const exe = key(row.executable), name = path.win32.basename(exe);
  const product = String(row.product || '').toLowerCase(), company = String(row.company || '').toLowerCase();
  if (['chatgpt.exe', 'codex.exe'].includes(name) && product === 'codex' && company.includes('openai')) {
    return { harness: 'codex', kind: 'desktop' };
  }
  if (name === 'codex.exe' && /\\(?:openai\\codex\\bin\\[^\\]+|@openai\\codex[^\\]*\\vendor\\[^\s]+|\.codex\\bin)\\codex\.exe$/.test(exe)) {
    return { harness: 'codex', kind: 'cli' };
  }
  if (name === 'claude.exe' && product === 'claude code' && company.includes('anthropic')) return { harness: 'claude', kind: 'cli' };
  if (name === 'claude.exe' && product === 'claude' && company.includes('anthropic')) return { harness: 'claude', kind: 'desktop' };
  if (['opencode.exe', 'opencode-cli.exe'].includes(name)
    && (/^opencode(?: desktop)?$/.test(product) || /\\(?:\.opencode\\bin|opencode[^\\]*\\bin|opencode|opencode-desktop)\\(?:opencode|opencode-cli)\.exe$/.test(exe))) {
    return { harness: 'opencode', kind: product.includes('desktop') || exe.includes('opencode-desktop') ? 'desktop' : 'cli' };
  }
  if (['node.exe', 'bun.exe'].includes(name)) {
    const entry = processEntry(row)[1] || '';
    if (/\\node_modules\\@anthropic-ai\\claude-code\\cli\.js$/.test(entry)) return { harness: 'claude', kind: 'cli' };
    if (/\\node_modules\\@openai\\codex\\bin\\codex\.js$/.test(entry)) return { harness: 'codex', kind: 'cli' };
    if (/\\node_modules\\opencode-ai\\bin\\opencode(?:\.js)?$/.test(entry)) return { harness: 'opencode', kind: 'cli' };
  }
  return null;
}

function infrastructure(row) {
  const entries = processEntry(row);
  return /^(?:chrome|msedge|firefox|code|devenv|unity)\.exe$/i.test(path.win32.basename(row.executable || ''))
    || entries.some(entry => /\\lark\\src\\gateway\.mjs$/.test(entry)
    || /\\node_modules\\(?:@[^\\]+\\)?lark-cli\\/.test(entry)
    || /\\(?:lark-cli|lark-cli-core)\.exe$/.test(entry));
}

function publicRow(row) {
  return { pid: row.pid, procStart: row.procStart, executable: row.executable,
    ownerSid: row.ownerSid, harness: row.harness, kind: row.kind, reason: row.reason };
}

export function planOffWork(snapshot, { protectedPids = [], selfPid = process.pid, detachedWorker = false } = {}) {
  const rows = Array.isArray(snapshot?.processes) ? snapshot.processes : [];
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const structurallyComplete = snapshot?.complete === true && Array.isArray(snapshot.processes)
    && /^S-1-/.test(snapshot.ownerSid || '') && rows.length <= 10000 && byPid.size === rows.length
    && rows.every(row => Number.isSafeInteger(row.pid) && row.pid > 0);
  const children = new Map();
  for (const row of rows) {
    const parent = byPid.get(row.parentPid);
    if (!parent || !validIdentity(parent) || !validIdentity(row) || BigInt(parent.procStart) > BigInt(row.procStart)) continue;
    const list = children.get(parent.pid) || [];
    list.push(row); children.set(parent.pid, list);
  }
  function descendants(pid, seen = new Set()) {
    if (seen.has(pid)) return seen;
    seen.add(pid);
    for (const child of children.get(pid) || []) descendants(child.pid, seen);
    return seen;
  }
  const protectedSet = new Set(), workerSet = descendants(selfPid);
  for (const row of rows) if (protectedPids.includes(row.pid) || infrastructure(row)) {
    for (const pid of descendants(row.pid)) protectedSet.add(pid);
  }
  // A verified detached worker survives parent termination; normal callers protect ancestors.
  if (!detachedWorker) for (const pid of workerSet) protectedSet.add(pid);
  const protectedAncestors = new Set(protectedSet);
  for (const pid of protectedSet) {
    let row = byPid.get(pid); const seen = new Set();
    while (row && !seen.has(row.pid)) {
      seen.add(row.pid); protectedAncestors.add(row.pid);
      const parent = byPid.get(row.parentPid);
      row = parent && validIdentity(parent) && validIdentity(row) && BigInt(parent.procStart) <= BigInt(row.procStart) ? parent : null;
    }
  }
  const selected = new Map(), retained = [], unknown = [];
  for (const row of rows) {
    const agent = identifyAgentProcess(row);
    if (!agent) {
      if (/^(codex|claude|chatgpt|opencode|opencode-cli)\.exe$/i.test(row.name || '')
        && (row.ownerSid === snapshot.ownerSid || !row.ownerSid && row.sessionId === snapshot.sessionId)) unknown.push(publicRow({ ...row, reason: 'unverified_program' }));
      continue;
    }
    if (row.ownerSid !== snapshot.ownerSid || !validIdentity(row)) {
      if (!row.ownerSid || row.ownerSid === snapshot.ownerSid) unknown.push(publicRow({ ...row, ...agent, reason: 'identity_unverified' }));
      continue;
    }
    if (protectedAncestors.has(row.pid)) {
      retained.push(publicRow({ ...row, ...agent, reason: 'protected_infrastructure' })); continue;
    }
    for (const pid of descendants(row.pid)) {
      const item = byPid.get(pid);
      if (!item || protectedAncestors.has(pid) || workerSet.has(pid) || item.ownerSid !== snapshot.ownerSid) continue;
      if (!selected.has(pid)) selected.set(pid, { ...item, ...agent, kind: pid === row.pid ? agent.kind : 'child' });
    }
  }
  // Restore the independently verified client identity where an outer root also discovered it.
  for (const [pid, row] of selected) Object.assign(row, identifyAgentProcess(byPid.get(pid)) || {});
  const targets = [...selected.values()].sort((a, b) => (a.kind === 'desktop' ? -1 : 0) - (b.kind === 'desktop' ? -1 : 0)
    || (BigInt(a.procStart) < BigInt(b.procStart) ? -1 : 1)).map(publicRow);
  return { status: 'preview', complete: structurallyComplete && targets.length <= 2048, scope: 'current_windows_user',
    supported: ['claude', 'codex', 'opencode'], targets, retained, unknown,
    warnings: snapshot?.warnings || [], generatedAt: new Date().toISOString() };
}

export async function windowsOffWork(request, { run = runProcess, env = process.env } = {}) {
  if (process.platform !== 'win32') throw new Error('下班功能当前仅支持 Windows');
  const systemRoot = env.SystemRoot || env.SYSTEMROOT;
  if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error('SystemRoot is unavailable');
  const result = await run(path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(scriptDirectory, 'off-work-windows.ps1')],
    { cwd: scriptDirectory, input: JSON.stringify(request), timeoutMs: 25000, maxOutputBytes: 8 * 1024 * 1024 });
  if (result.code !== 0 || result.stderr.trim()) throw new Error(`下班进程助手失败 (${result.code})`);
  const payload = JSON.parse(result.stdout);
  if (!payload || typeof payload !== 'object') throw new Error('Invalid off-work helper result');
  return payload;
}

export async function verifyCodexLocks({ codexRoot = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), probe = runWindowsSessionProbe } = {}) {
  const root = path.join(codexRoot, 'thread-writer-locks');
  let entries;
  try {
    if (fs.lstatSync(root).isSymbolicLink()) return { complete: false, held: [], unknown: ['linked_lock_directory'] };
    entries = fs.readdirSync(root, { withFileTypes: true });
  }
  catch (error) { return { complete: error.code === 'ENOENT', held: [], unknown: error.code === 'ENOENT' ? [] : ['lock_directory_unreadable'] }; }
  const files = entries.filter(entry => /^[a-f\d-]{36}\.lock$/i.test(entry.name));
  if (files.length > 20000) return { complete: false, held: [], unknown: ['lock_limit'] };
  const held = [], unknown = [];
  for (let index = 0; index < files.length; index += 512) {
    const batch = files.slice(index, index + 512);
    const locks = batch.filter(entry => entry.isFile() && !entry.isSymbolicLink()).map(entry => ({ id: entry.name.slice(0, -5), path: path.join(root, entry.name) }));
    for (const entry of batch) if (!entry.isFile() || entry.isSymbolicLink()) unknown.push(entry.name);
    try {
      const result = await probe({ locks, processes: [], timeoutMs: 5000 });
      for (const lock of locks) {
        const state = result.locks.get(lock.id)?.state;
        if (state === 'held') held.push(lock.id);
        else if (!['free', 'missing'].includes(state)) unknown.push(lock.id);
      }
    } catch { unknown.push('lock_probe_failed'); }
  }
  return { complete: unknown.length === 0, held, unknown };
}

export async function inspectOffWork(options = {}) {
  const backend = options.backend || windowsOffWork;
  const snapshot = await backend({ action: 'snapshot' });
  return planOffWork(snapshot, options);
}

export async function executeOffWork(options = {}) {
  const backend = options.backend || windowsOffWork;
  const plan = options.plan || await inspectOffWork(options);
  if (!plan.complete) return { ...plan, status: 'incomplete', released: false, outcomes: [] };
  const results = plan.targets.length ? await backend({ action: 'shutdown', targets: plan.targets }) : { outcomes: [] };
  const after = await inspectOffWork(options);
  const locks = await (options.verifyLocks || verifyCodexLocks)();
  const outcomes = Array.isArray(results.outcomes) ? results.outcomes : [];
  const accounted = plan.targets.every(target => outcomes.some(row => row.pid === target.pid && row.procStart === target.procStart
    && ['exited', 'closed', 'terminated'].includes(row.state)));
  const released = accounted && after.complete && !after.targets.length && !after.retained.length && !after.unknown.length && locks.complete && !locks.held.length;
  return { status: released ? 'completed' : 'partial', released, generatedAt: new Date().toISOString(),
    scope: plan.scope, supported: plan.supported, outcomes, remaining: after.targets, retained: after.retained,
    unknown: after.unknown, warnings: after.warnings, codexLocks: locks,
    verification: 'Claude/OpenCode: identified processes exited; Codex: processes and native writer locks' };
}

export function formatOffWork(result) {
  const names = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };
  if (result.status === 'preview') {
    const counts = new Map();
    for (const row of result.targets) if (row.kind !== 'child') counts.set(row.harness, (counts.get(row.harness) || 0) + 1);
    return ['下班检查（未关闭进程）', ...[...counts].map(([h, n]) => `${names[h]}：${n} 个客户端进程`),
      `共将关闭 ${result.targets.length} 个客户端及子进程；保留 ${result.retained.length} 个受保护客户端；身份待核验 ${result.unknown.length} 个。`,
      ...(result.complete ? [] : ['进程扫描不完整，不能执行。']), '发送“下班”会停止当前 Agent 工作并关闭客户端，保留网关。'].join('\n');
  }
  const closed = (result.outcomes || []).filter(row => ['exited', 'closed', 'terminated'].includes(row.state)).length;
  const lines = [result.released ? '下班完成：已识别客户端退出，Codex 写锁核验通过。' : '下班未完全完成，请查看剩余占用。',
    `已退出 ${closed} 个进程；仍运行 ${(result.remaining || []).length} 个；保留 ${(result.retained || []).length} 个；身份待核验 ${(result.unknown || []).length} 个。`];
  const remaining = [...(result.remaining || []), ...(result.retained || []), ...(result.unknown || [])];
  for (const row of remaining.slice(0, 15)) lines.push(`${names[row.harness] || '未知客户端'} | PID ${row.pid} | ${row.reason || '仍在运行'}`);
  if (remaining.length > 15) lines.push(`另有 ${remaining.length - 15} 个进程，详见本机报告。`);
  const failed = (result.outcomes || []).filter(row => !['exited', 'closed', 'terminated'].includes(row.state));
  for (const row of failed.slice(0, 10)) lines.push(`未确认退出：PID ${row.pid} | ${row.state}`);
  if (result.status === 'incomplete') lines.push('进程扫描不完整，本次未执行关闭。');
  if (result.codexLocks?.held?.length) lines.push(`Codex 仍占用 ${result.codexLocks.held.length} 个 Session。`);
  if (result.codexLocks?.complete === false) lines.push('部分 Codex 写锁无法核验。');
  lines.push('保留会话记录；网关继续运行。Claude/OpenCode 仅核验已识别客户端退出。');
  return lines.join('\n');
}
