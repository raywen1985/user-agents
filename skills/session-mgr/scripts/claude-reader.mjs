import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const idOf = value => typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;
const clean = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
const timestamp = value => typeof value === 'number' ? value : Date.parse(value || '') || 0;

export function fail(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

export function defaultRoot(value = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')) {
  if (value === '~') value = os.homedir();
  if (/^~[\\/]/.test(value)) value = path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

// Each component is checked: a safe leaf alone does not rule out a junction parent.
export async function safeStat(root, relative) {
  const absolute = path.resolve(root, relative);
  const within = path.relative(root, absolute);
  if (!within || within === '..' || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) {
    throw fail('unsafe_path', 'Target is not a child of the selected data root', { path: absolute });
  }
  let current = root;
  for (const component of within.split(path.sep)) {
    current = path.join(current, component);
    let stat;
    try { stat = await fs.lstat(current); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw fail('unsafe_path', 'Linked paths are not supported', { path: current });
    }
    if (current !== absolute && !stat.isDirectory()) throw fail('unsafe_path', 'Parent is not a directory');
    if (current === absolute) return stat;
  }
}

export async function directory(root, relative) {
  const stat = await safeStat(root, relative);
  if (!stat) return [];
  if (!stat.isDirectory()) throw fail('unsupported_layout', `Expected directory: ${relative}`);
  return fs.readdir(path.join(root, relative), { withFileTypes: true });
}

export async function read(root, relative) {
  const stat = await safeStat(root, relative);
  if (!stat) return null;
  if (!stat.isFile()) throw fail('unsupported_layout', `Expected file: ${relative}`);
  return fs.readFile(path.join(root, relative), 'utf8');
}

export function parseJSON(text, source) {
  try { return JSON.parse(text.replace(/^\uFEFF/, '')); } catch {
    throw fail('invalid_json', `Invalid JSON: ${source}`);
  }
}

async function json(root, relative) {
  const text = await read(root, relative);
  return text === null ? null : parseJSON(text, relative);
}

export async function canonicalRoot(input) {
  const root = defaultRoot(input);
  try { return await fs.realpath(root); } catch (error) {
    if (error.code === 'ENOENT') return root;
    throw error;
  }
}

export async function canonicalProject(value) {
  const absolute = defaultRoot(value);
  try { return await fs.realpath(absolute); } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) return absolute;
    throw error;
  }
}

export const projectKey = value => process.platform === 'win32' ? value.toLowerCase() : value;

export async function resolveScope(input) {
  const scope = input.scope ?? 'current';
  if (!['current', 'all'].includes(scope)) throw fail('invalid_scope', 'Use --scope current or --scope all');
  if (scope === 'all' && input.project !== undefined) throw fail('invalid_scope', '--project only applies to current scope');
  return { scope, currentProject: scope === 'current' ? await canonicalProject(input.project ?? process.cwd()) : null };
}

export async function probeProcesses(records) {
  if (!records.length) return [];
  if (process.platform !== 'win32') {
    return records.map(record => {
      try { process.kill(record.pid, 0); return { key: record.key, state: 'active' }; } catch (error) {
        return { key: record.key, state: error.code === 'ESRCH' ? 'inactive' : 'unknown', reason: error.code };
      }
    });
  }
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
  if (!systemRoot) throw new Error('SystemRoot is unavailable for process verification');
  const executable = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = fileURLToPath(new URL('./probe-processes.ps1', import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Process verification timed out')); }, 10000);
    child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
    child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdin.on('error', () => {});
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`Process verification failed: ${stderr.trim()}`));
      try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, ''))); } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(records));
  });
}

export async function readClaudeRegistry(root, { maximumEntries = Infinity, signal } = {}) {
  const records = [], warnings = [];
  let unknown = false;
  try {
    const entries = await directory(root, 'sessions');
    if (entries.length > maximumEntries) throw fail('incomplete_scan', 'Claude registry exceeds the entry limit');
    for (const entry of entries) {
      if (!entry.name.toLowerCase().endsWith('.json')) continue;
      try {
        signal?.throwIfAborted();
        const relative = path.join('sessions', entry.name);
        const stat = await safeStat(root, relative);
        if (!stat?.isFile() || stat.size > 65536) throw fail('unsupported_layout', 'Invalid registry file');
        const value = await json(root, relative);
        const id = idOf(value?.sessionId);
        if (!id || !Number.isSafeInteger(value.pid) || value.pid <= 0) throw new Error('Invalid session ID or PID');
        records.push({ ...value, id, key: entry.name, sourcePath: path.join(root, relative), mtimeMs: stat.mtimeMs });
      } catch (error) { unknown = true; warnings.push(`sessions/${entry.name}: ${error.message}`); }
    }
  } catch (error) { unknown = true; warnings.push(error.message); }
  return { records, unknown, warnings };
}

async function registry(root, probe) {
  const scanned = await readClaudeRegistry(root);
  const { records, warnings } = scanned;
  let unknown = scanned.unknown;
  let statuses = new Map();
  try {
    const results = await probe(records.map(({ key, pid, procStart }) => ({ key, pid, procStart })));
    if (!Array.isArray(results) || results.length !== records.length
      || new Set(results.map(item => item.key)).size !== records.length
      || results.some(item => !records.some(record => record.key === item.key)
        || !['active', 'inactive', 'unknown'].includes(item.state))) throw new Error('Incomplete process verification');
    statuses = new Map(results.map(item => [item.key, item]));
  } catch (error) { unknown = true; warnings.push(error.message); }
  return { records, statuses, unknown, warnings };
}

export async function listSessions(input = {}) {
  const context = await resolveScope(input);
  const root = await canonicalRoot(input.root);
  const sessions = new Map(), warnings = [];
  let complete = true, projectCount = 0, entryCount = 0;
  function get(id) {
    if (!sessions.has(id)) sessions.set(id, {
      id, name: '', nameSource: 'unnamed', project: '', projectPaths: [], indexProjectPaths: [], initialProjectPaths: [], projectDirs: [], sources: [], updatedAtMs: 0, lastActiveAtMs: 0, titleTime: 0,
    });
    return sessions.get(id);
  }
  function title(session, value, source, time = 0, priority = 0) {
    const name = clean(value);
    if (!name) return;
    const prior = session.titlePriority ?? -1;
    if (priority > prior || (priority === prior && time >= session.titleTime)) {
      Object.assign(session, { name, nameSource: source, titleTime: time, titlePriority: priority });
    }
  }
  function update(session, data, source) {
    if (source && !session.sources.includes(source)) session.sources.push(source);
    const project = data.projectPath || data.project || data.cwd;
    if (typeof project === 'string' && path.isAbsolute(project)) {
      session.project ||= project;
      if (!session.projectPaths.includes(project)) session.projectPaths.push(project);
    }
    session.updatedAtMs = Math.max(session.updatedAtMs, timestamp(data.modified), timestamp(data.timestamp), timestamp(data.updatedAt));
  }
  function recordActivity(session, value) {
    session.lastActiveAtMs = Math.max(session.lastActiveAtMs, timestamp(value));
  }
  async function attempt(source, work) {
    try { await work(); } catch (error) { complete = false; warnings.push(`${source}: ${error.message}`); }
  }
  await attempt('projects', async () => {
    for (const project of await directory(root, 'projects')) {
      if (!project.isDirectory() && !project.isSymbolicLink()) continue;
      if (++projectCount > (input.maximumProjectDirectories ?? Infinity)) throw fail('incomplete_scan', 'Project directory limit exceeded');
      const relative = path.join('projects', project.name);
      await attempt(relative, async () => {
        const entries = await directory(root, relative);
        entryCount += entries.length;
        if (entryCount > (input.maximumEntries ?? Infinity)) throw fail('incomplete_scan', 'Session entry limit exceeded');
        const index = await json(root, path.join(relative, 'sessions-index.json'));
        if (index !== null) {
          if (!Array.isArray(index.entries)) throw fail('unsupported_layout', 'sessions-index.json has no entries array');
          if (index.entries.length > (input.maximumEntries ?? Infinity)) throw fail('incomplete_scan', 'Session index limit exceeded');
          for (const item of index.entries) {
            const id = idOf(item.sessionId);
            if (!id) continue;
            const session = get(id);
            if (!session.projectDirs.includes(relative)) session.projectDirs.push(relative);
            update(session, { ...item, projectPath: item.projectPath || index.originalPath }, path.join(relative, 'sessions-index.json'));
            const recordProject = item.projectPath || index.originalPath;
            if (typeof recordProject === 'string' && path.isAbsolute(recordProject)) session.indexProjectPaths.push(recordProject);
            recordActivity(session, item.modified || item.created);
            title(session, item.customTitle, 'index-custom-title', timestamp(item.modified), 4);
            if (!input.metadataOnly) title(session, item.summary || item.firstPrompt, 'index-summary', 0, 2);
          }
        }
        for (const entry of entries) {
          const id = idOf(entry.name.replace(/\.jsonl$/i, ''));
          if (!id) continue;
          const source = path.join(relative, entry.name);
          await attempt(source, async () => {
            const stat = await safeStat(root, source);
            if (!stat) return;
            const session = get(id);
            if (!session.projectDirs.includes(relative)) session.projectDirs.push(relative);
            session.updatedAtMs = Math.max(session.updatedAtMs, stat.mtimeMs);
            update(session, {}, source);
            if (stat.isDirectory()) {
              const titlePath = path.join(source, 'custom-title.json');
              const custom = await json(root, titlePath);
              if (custom) title(session, custom.customTitle, 'custom-title-file', (await safeStat(root, titlePath)).mtimeMs, 5);
            } else if (stat.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) {
              const lines = createInterface({ input: createReadStream(path.join(root, source), { encoding: 'utf8' }), crlfDelay: Infinity });
              let malformed = 0, firstPrompt = false, initialProject = false;
              for await (const line of lines) {
                if (!line.trim()) continue;
                let item;
                try { item = JSON.parse(line.replace(/^\uFEFF/, '')); } catch { malformed++; continue; }
                if (!item || typeof item !== 'object') { malformed++; continue; }
                if (item.sessionId && idOf(item.sessionId) !== id) continue;
                update(session, item);
                // Later cd operations remain discovery/display evidence, not a
                // second storage location for deletion. Index ownership wins.
                if (!initialProject && typeof item.cwd === 'string' && path.isAbsolute(item.cwd)) {
                  session.initialProjectPaths.push(item.cwd); initialProject = true;
                }
                if (input.includeEvidence && idOf(item.sessionId) === id && typeof item.cwd === 'string' && path.isAbsolute(item.cwd)) {
                  session.nativeEvidence ||= [];
                  // Keep only explicit session/cwd envelope evidence, never message content.
                  const evidence = { source, cwd: item.cwd };
                  if (!session.nativeEvidence.some(prior => prior.source === source && prior.cwd === evidence.cwd)) session.nativeEvidence.push(evidence);
                }
                if (['user', 'assistant', 'system'].includes(item.type)) recordActivity(session, item.timestamp);
                if (item.type === 'custom-title') title(session, item.customTitle, 'transcript-custom-title', timestamp(item.timestamp), 4);
                if (!input.metadataOnly && item.type === 'summary') title(session, item.summary, 'transcript-summary', timestamp(item.timestamp), 2);
                if (!input.metadataOnly && item.type === 'user' && !item.isMeta && !firstPrompt) {
                  const content = item.message?.content;
                  const text = typeof content === 'string' ? content : Array.isArray(content)
                    ? content.filter(block => block.type === 'text').map(block => block.text).join(' ') : '';
                  if (clean(text)) { title(session, clean(text).slice(0, 100), 'first-prompt', 0, 1); firstPrompt = true; }
                }
              }
              if (malformed) warnings.push(`${source}: skipped ${malformed} malformed transcript lines`);
            }
          });
        }
      });
    }
  });
  await attempt('history.jsonl', async () => {
    const text = await read(root, 'history.jsonl');
    if (text === null) return;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const item = parseJSON(line, 'history.jsonl');
      const id = idOf(item?.sessionId);
      if (!id) continue;
      const session = get(id);
      update(session, item, 'history.jsonl');
      recordActivity(session, item.timestamp);
      if (!input.metadataOnly && !session.name) title(session, clean(item.display).slice(0, 100), 'history-prompt', 0, 0);
    }
  });
  const live = await registry(root, input.probe || probeProcesses);
  warnings.push(...live.warnings);
  for (const item of live.records) {
    // A dead registry entry by itself is not a saved Session. Keeping it visible
    // would make a successfully deleted Session appear to survive forever.
    if (live.statuses.get(item.key)?.state === 'inactive' && !sessions.has(item.id)) continue;
    const session = get(item.id);
    update(session, item, path.join('sessions', item.key));
    recordActivity(session, item.lastActiveAt || item.lastActivityAt || item.statusUpdatedAt || item.updatedAt || item.startedAt);
    if (live.statuses.get(item.key)?.state === 'active') {
      title(session, item.name, 'live-name', Number(item.nameSince || item.updatedAt || 0), 5);
    }
  }
  const projectCache = new Map();
  const result = [];
  let unassignedCount = 0;
  for (const session of sessions.values()) {
    const projects = new Map();
    for (const value of session.projectPaths) {
      if (!projectCache.has(value)) projectCache.set(value, await canonicalProject(value));
      const canonical = projectCache.get(value);
      projects.set(projectKey(canonical), canonical);
    }
    if (!projects.size) unassignedCount++;
    if (context.scope === 'current' && !projects.has(projectKey(context.currentProject))) continue;
    const owners = live.records.filter(item => item.id === session.id).map(item => ({
      pid: item.pid, procStart: item.procStart || null,
      state: live.statuses.get(item.key)?.state || 'unknown',
      reason: live.statuses.get(item.key)?.reason || null,
    }));
    const state = owners.some(item => item.state === 'active') ? 'active'
      : live.unknown || owners.some(item => item.state === 'unknown') ? 'unknown' : 'inactive';
    const recordPaths = session.indexProjectPaths.length ? session.indexProjectPaths : session.initialProjectPaths.length ? session.initialProjectPaths
      : session.projectDirs.length ? [] : session.projectPaths;
    const recordProjects = new Map();
    for (const value of recordPaths) {
      if (!projectCache.has(value)) projectCache.set(value, await canonicalProject(value));
      const canonical = projectCache.get(value); recordProjects.set(projectKey(canonical), canonical);
    }
    const { titleTime, titlePriority, updatedAtMs, lastActiveAtMs, projectPaths, indexProjectPaths, initialProjectPaths, ...publicSession } = session;
    result.push({ ...publicSession, name: session.name || '(unnamed)', projects: [...projects.values()], recordProjects: [...recordProjects.values()],
      updatedAt: updatedAtMs ? new Date(updatedAtMs).toISOString() : null,
      lastActiveAt: (lastActiveAtMs || updatedAtMs) ? new Date(lastActiveAtMs || updatedAtMs).toISOString() : null,
      activity: { state, owners, reason: state === 'unknown' ? live.warnings.join('; ') || 'Process identity could not be verified' : null },
    });
  }
  result.sort(byRecentActivity);
  return { root, ...context, total: result.length, unassignedCount, complete, warnings, sessions: result };
}

export function byRecentActivity(a, b) {
  return timestamp(b.lastActiveAt || b.updatedAt) - timestamp(a.lastActiveAt || a.updatedAt)
    || String(a.harness || '').localeCompare(String(b.harness || '')) || a.id.localeCompare(b.id);
}

function similarity(a, b) {
  // Dice coefficient of Unicode bigrams provides useful typo candidates, never authority to delete.
  const grams = value => { const chars = [...value]; return new Set(chars.slice(1).map((c, i) => chars[i] + c)); };
  const left = grams(a), right = grams(b);
  return left.size + right.size ? 2 * [...left].filter(item => right.has(item)).length / (left.size + right.size) : 0;
}

export function matchSessions(sessions, query) {
  const text = clean(query).toLowerCase();
  if (!text) throw fail('invalid_query', 'Provide a nonempty Session name or ID');
  const ids = sessions.filter(item => item.id === text).sort(byRecentActivity);
  if (ids.length) return { kind: 'exact_id', candidates: ids };
  const names = sessions.filter(item => item.name.toLowerCase() === text).sort(byRecentActivity);
  if (names.length) return { kind: names.length === 1 ? 'exact_name' : 'ambiguous', candidates: names };
  const candidates = sessions.flatMap(item => {
    const name = item.name.toLowerCase();
    let score = name.includes(text) || item.id.includes(text) ? 1 : 0;
    if (!score && text.length >= 2) {
      let index = 0;
      for (const character of name) if (character === text[index]) index++;
      if (index === text.length) score = 0.7;
      score = Math.max(score, similarity(name, text) >= 0.5 ? similarity(name, text) : 0);
    }
    return score ? [item] : [];
  }).sort(byRecentActivity);
  return { kind: candidates.length ? 'fuzzy' : 'none', candidates };
}
export async function readClaudeEnvelope(transcriptPath, sessionId, maximumBytes = 262144, maximumLines = 64) {
  if (path.basename(transcriptPath).toLowerCase() !== sessionId.toLowerCase() + '.jsonl') return { ok: false, reason: 'stale_target' };
  const root = path.dirname(path.dirname(path.dirname(transcriptPath)));
  if (path.basename(path.dirname(path.dirname(transcriptPath))) !== 'projects') return { ok: false, reason: 'stale_target' };
  const stat = await safeStat(root, path.relative(root, transcriptPath));
  if (!stat?.isFile()) return { ok: false, reason: "missing_transcript" };
  const handle = await fs.open(transcriptPath, "r");
  try {
    const length = Math.min(stat.size, maximumBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    const text = buffer.toString("utf8");
    const lines = text.split(/\r?\n/).slice(0, maximumLines);
    for (const line of lines) {
      if (!line.trim()) continue;
      let payload;
      try { payload = JSON.parse(line); } catch { continue; }
      if (String(payload.sessionId || "").toLowerCase() !== sessionId) continue;
      if (typeof payload.cwd !== "string" || !path.isAbsolute(payload.cwd)) continue;
      return { ok: true, cwd: payload.cwd, updatedAt: Date.parse(payload.timestamp || "") || stat.mtimeMs };
    }
    return { ok: false, reason: stat.size > maximumBytes ? "metadata_prefix_exceeded" : "project_unverified" };
  } finally {
    await handle.close();
  }
}
