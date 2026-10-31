import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fail, safeStat, directory, read, parseJSON, canonicalRoot, idOf, projectKey, listSessions, matchSessions } from './claude-reader.mjs';
export { fail, defaultRoot, safeStat, canonicalProject, resolveScope, projectKey, probeProcesses, listSessions, byRecentActivity, matchSessions } from './claude-reader.mjs';
const digest = value => createHash('sha256').update(value).digest('hex');

export async function hashFile(root, relative) {
  const stat = await safeStat(root, relative);
  if (!stat?.isFile()) throw fail('stale_preview', `File no longer exists: ${relative}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path.join(root, relative))) hash.update(chunk);
  return { path: relative, bytes: stat.size, sha256: hash.digest('hex') };
}

function historyUpdate(text, id) {
  let removed = 0;
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
  const after = lines.filter(line => {
    if (!line.trim()) return true;
    const value = parseJSON(line, 'history.jsonl');
    if (idOf(value?.sessionId) !== id) return true;
    removed++; return false;
  }).join('');
  return { removed, after };
}

async function buildPlan(catalog, session) {
  const { root, scope, currentProject } = catalog;
  if (scope === 'current' && (session.projectDirs.length > 1
    || session.recordProjects.some(project => projectKey(project) !== projectKey(currentProject)))) {
    throw fail('cross_project_session', 'Stored Session records belong to another project or multiple project directories; historical working directories alone do not cause this restriction', {
      id: session.id, scope, currentProject, recordProjects: session.recordProjects, observedProjects: session.projects, projectDirs: session.projectDirs,
    });
  }
  const files = [], directories = [], sharedUpdates = [];
  async function collect(relative) {
    const stat = await safeStat(root, relative);
    if (!stat) return;
    if (stat.isFile()) files.push(await hashFile(root, relative));
    else if (stat.isDirectory()) {
      directories.push(relative);
      for (const entry of await directory(root, relative)) await collect(path.join(relative, entry.name));
    } else throw fail('unsafe_path', `Unsupported file type: ${relative}`);
  }
  const id = session.id;
  for (const project of session.projectDirs) {
    // Resolve existing spelling from directory entries, including uppercase UUIDs on case-sensitive systems.
    for (const entry of await directory(root, project)) {
      if (idOf(entry.name.replace(/\.jsonl$/i, '')) === id) await collect(path.join(project, entry.name));
    }
    const relative = path.join(project, 'sessions-index.json');
    const text = await read(root, relative);
    if (text !== null) {
      const value = parseJSON(text, relative);
      if (!Array.isArray(value.entries)) throw fail('unsupported_layout', `Unknown index format: ${relative}`);
      const entries = value.entries.filter(item => idOf(item?.sessionId) !== id);
      const removed = value.entries.length - entries.length;
      if (removed) sharedUpdates.push({ path: relative, removed, sha256: digest(text), after: JSON.stringify({ ...value, entries }, null, 2) + '\n' });
    }
  }
  for (const family of ['file-history', 'session-env', 'tasks', 'todos', 'debug']) {
    for (const entry of await directory(root, family)) {
      const lower = entry.name.toLowerCase();
      const owned = ['file-history', 'session-env', 'tasks'].includes(family) ? idOf(entry.name) === id
        : family === 'debug' ? lower === `${id}.txt`
          : new RegExp(`^${id}-agent-[a-z0-9-]+\\.json$`).test(lower);
      if (owned) await collect(path.join(family, entry.name));
    }
  }
  const history = await read(root, 'history.jsonl');
  if (history !== null) {
    const change = historyUpdate(history, id);
    if (change.removed) sharedUpdates.push({ path: 'history.jsonl', sha256: digest(history), ...change });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  directories.sort(); sharedUpdates.sort((a, b) => a.path.localeCompare(b.path));
  const identity = session.activity.owners.map(({ pid, procStart, state }) => ({ pid, procStart, state }))
    .sort((a, b) => a.pid - b.pid);
  const fingerprint = digest(JSON.stringify({ root, scope, currentProject: currentProject && projectKey(currentProject), id, files, directories,
    shared: sharedUpdates.map(({ after, ...rest }) => rest), activity: session.activity.state, identity }));
  return { status: 'ready', root, scope, currentProject, session, files, directories, sharedUpdates, fingerprint,
    localDataPresent: Boolean(files.length || directories.length || sharedUpdates.length),
    fileCount: files.length, sharedRecordCount: sharedUpdates.reduce((sum, item) => sum + item.removed, 0),
    requiresConfirmation: session.activity.state === 'inactive' ? null : session.activity.state };
}

export function publicPlan(plan) {
  return { ...plan, sharedUpdates: plan.sharedUpdates.map(({ after, ...rest }) => rest) };
}

export async function previewDelete(options = {}) {
  if (options.id && !idOf(options.id)) throw fail('invalid_id', 'Deletion requires a complete Session UUID');
  const catalog = await listSessions(options);
  if (!catalog.complete) throw fail('incomplete_scan', 'Cannot safely resolve deletion from an incomplete scan', { warnings: catalog.warnings });
  // Explicit IDs must never fall back to another Session's title or fuzzy match.
  const match = options.id
    ? { kind: 'exact_id', candidates: catalog.sessions.filter(item => item.id === idOf(options.id)) }
    : matchSessions(catalog.sessions, options.query);
  const context = { root: catalog.root, scope: catalog.scope, currentProject: catalog.currentProject };
  if (!match.candidates.length) return { status: 'not_found', ...context, candidates: [] };
  if (!['exact_id', 'exact_name'].includes(match.kind)) return {
    status: 'selection_required', match: match.kind, ...context,
    candidates: match.candidates.map((item, index) => ({ number: index + 1, ...item })),
  };
  return publicPlan(await buildPlan(catalog, match.candidates[0]));
}

async function replaceShared(root, update) {
  const current = await read(root, update.path);
  if (current === null || digest(current) !== update.sha256) throw fail('stale_preview', `Shared file changed: ${update.path}`);
  const destination = path.join(root, update.path);
  const temporary = `${destination}.session-manager-${randomUUID()}.tmp`;
  const stat = await safeStat(root, update.path);
  try {
    await fs.writeFile(temporary, update.after, { flag: 'wx', mode: stat.mode & 0o777 });
    const again = await read(root, update.path);
    if (again === null || digest(again) !== update.sha256) throw fail('stale_preview', `Shared file changed: ${update.path}`);
    await fs.rename(temporary, destination);
  } finally {
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function executeDelete(options = {}) {
  if (!idOf(options.id) || !/^[a-f0-9]{64}$/.test(options.expect || '')) {
    throw fail('preview_required', 'Execute requires a complete --id and --expect fingerprint from a preview');
  }
  const root = await canonicalRoot(options.root);
  const lock = path.join(root, '.session-manager-delete.lock');
  let handle;
  try { handle = await fs.open(lock, 'wx', 0o600); } catch (error) {
    if (error.code === 'EEXIST') throw fail('locked', 'Another deletion is running or left a lock; inspect its owner before removing it');
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    const catalog = await listSessions({ ...options, root });
    if (!catalog.complete) throw fail('incomplete_scan', 'Deletion scan is incomplete', { warnings: catalog.warnings });
    const session = catalog.sessions.find(item => item.id === idOf(options.id));
    if (!session) throw fail('not_found', 'Session no longer exists');
    const plan = await buildPlan(catalog, session);
    if (plan.fingerprint !== options.expect) throw fail('stale_preview', 'Files or process identity changed; preview again', { preview: publicPlan(plan) });
    if (session.activity.state === 'active' && !options.allowActive) {
      throw fail('active_confirmation_required', 'Session is still active; ask the user before deleting its local records', { preview: publicPlan(plan) });
    }
    if (session.activity.state === 'unknown' && !options.allowUnknown) {
      throw fail('unknown_confirmation_required', 'Activity could not be verified; ask the user before deleting', { preview: publicPlan(plan) });
    }
    // Self deletion must revalidate the caller after scans, before any data writes.
    if (options.verifyCurrentSession) await options.verifyCurrentSession();
    const deletedFiles = [], removedDirectories = [], updatedShared = [], errors = [];
    try {
      for (const update of plan.sharedUpdates) {
        await replaceShared(root, update);
        updatedShared.push({ path: update.path, removed: update.removed });
      }
      for (const file of plan.files) {
        const current = await hashFile(root, file.path);
        if (current.sha256 !== file.sha256) throw fail('stale_preview', `File changed during deletion: ${file.path}`);
        await safeStat(root, file.path);
        await fs.unlink(path.join(root, file.path));
        deletedFiles.push(file.path);
      }
      // Never use recursive removal: new files or links must stop the operation.
      for (const relative of [...plan.directories].sort((a, b) => b.split(path.sep).length - a.split(path.sep).length)) {
        const stat = await safeStat(root, relative);
        if (!stat?.isDirectory()) throw fail('stale_preview', `Directory changed: ${relative}`);
        await fs.rmdir(path.join(root, relative));
        removedDirectories.push(relative);
      }
    } catch (error) { errors.push({ code: error.code || 'io_error', message: error.message }); }
    let remaining = [], runtimeStillActive = session.activity.state === 'active';
    try {
      const after = await listSessions({ ...options, root });
      const survivor = after.sessions.find(item => item.id === session.id);
      if (survivor) {
        runtimeStillActive = survivor.activity.state === 'active';
        const leftover = await buildPlan(after, survivor);
        remaining = [...leftover.files.map(item => item.path), ...leftover.directories, ...leftover.sharedUpdates.map(item => item.path)];
      }
      if (!after.complete) errors.push({ code: 'verification_incomplete', message: after.warnings.join('; ') });
    } catch (error) { errors.push({ code: 'verification_failed', message: error.message }); }
    return { status: errors.length || remaining.length ? 'partial' : plan.localDataPresent ? 'deleted' : 'no_local_records',
      scope: catalog.scope, currentProject: catalog.currentProject, id: session.id, name: session.name,
      deletedFiles, removedDirectories, updatedShared, errors, remaining, runtimeStillActive, recoverable: false };
  } finally {
    await handle.close();
    await fs.unlink(lock);
  }
}
