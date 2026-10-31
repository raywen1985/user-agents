import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fail, defaultRoot, resolveScope, canonicalProject, projectKey, byRecentActivity, matchSessions, safeStat, hashFile } from './session-store.mjs';
import { withCodex } from './codex-rpc.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sources = ['cli', 'vscode', 'exec', 'appServer', 'unknown'];
const allSources = [...sources, 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = value => typeof value === 'number' && Number.isFinite(value) && value > 0 ? new Date(value * 1000).toISOString() : null;
const clean = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';

export async function codexRoot(input) {
  const root = defaultRoot(input ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'));
  try { return await fs.realpath(root); } catch (error) { if (error.code === 'ENOENT') return root; throw error; }
}

async function pages(rpc, params) {
  const result = [], cursors = new Set();
  let cursor;
  do {
    const page = await rpc.call('thread/list', { limit: 100, modelProviders: [], sortKey: 'recency_at', sortDirection: 'desc', ...params, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(page?.data)) throw fail('codex_protocol_error', 'Invalid thread/list response');
    result.push(...page.data);
    cursor = page.nextCursor;
    if (cursor && (typeof cursor !== 'string' || cursors.has(cursor))) throw fail('incomplete_scan', 'Codex repeated a pagination cursor');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return result;
}

async function activity(root, thread) {
  if (['active', 'idle'].includes(thread.status?.type)) return { state: 'active', owners: [], reason: 'Thread is loaded in this app-server' };
  if (thread.status?.type !== 'notLoaded') return { state: 'unknown', owners: [], reason: 'Codex did not provide a usable runtime status' };
  const relative = path.join('thread-writer-locks', `${thread.id}.lock`);
  try {
    const stat = await safeStat(root, relative);
    if (!stat) return { state: 'inactive', owners: [], reason: 'No loaded thread or local writer lock observed' };
    if (!stat.isFile()) throw new Error('Unexpected writer-lock layout');
    if (process.platform !== 'win32') return { state: 'unknown', owners: [], reason: 'Writer lock exists; this runtime cannot inspect its advisory lock without acquiring it' };
    // Windows denies reads while Codex owns this exclusive writer lock. Never remove it.
    const file = await fs.open(path.join(root, relative), 'r');
    try { await file.read({ buffer: Buffer.alloc(1), position: 0 }); } finally { await file.close(); }
    return { state: 'inactive', owners: [], reason: 'Writer-lock file is not held' };
  } catch (error) {
    if (error.code === 'EBUSY') return { state: 'active', owners: [], reason: 'Another Codex process holds the writer lock' };
    return { state: 'unknown', owners: [], reason: `Writer identity could not be checked: ${error.message}` };
  }
}

async function normalize(root, thread, archived) {
  if (!thread || typeof thread.id !== 'string' || !UUID.test(thread.id)) throw fail('codex_protocol_error', 'Thread has no valid native ID');
  const project = typeof thread.cwd === 'string' && path.isAbsolute(thread.cwd) ? await canonicalProject(thread.cwd) : '';
  return { harness: 'codex', id: thread.id.toLowerCase(), name: clean(thread.name) || clean(thread.preview).slice(0, 100) || '(unnamed)',
    nameSource: thread.name ? 'native-name' : thread.preview ? 'first-prompt' : 'unnamed', project, projects: project ? [project] : [],
    archived, updatedAt: iso(thread.updatedAt), lastActiveAt: iso(thread.recencyAt) || iso(thread.updatedAt) || iso(thread.createdAt),
    activity: await activity(root, thread), parentThreadId: thread.parentThreadId || null, sessionTreeId: thread.sessionId || null,
    rolloutPath: thread.path || null, ephemeral: Boolean(thread.ephemeral) };
}

async function catalog(options, rpc) {
  const root = await codexRoot(options.root), context = await resolveScope(options);
  const sessions = new Map();
  for (const archived of [false, true]) {
    for (const thread of await pages(rpc, { archived, sourceKinds: sources })) {
      const item = await normalize(root, thread, archived); sessions.set(item.id, item);
    }
  }
  const all = [...sessions.values()];
  const selected = context.scope === 'all' ? all : all.filter(item => item.projects.some(project => projectKey(project) === projectKey(context.currentProject)));
  return { harness: 'codex', root, ...context, complete: true, warnings: [], unassignedCount: all.filter(item => !item.project).length,
    total: selected.length, sessions: selected.sort(byRecentActivity) };
}

export async function listCodexSessions(options = {}) {
  const root = await codexRoot(options.root);
  if (!await fs.stat(root).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) {
    return { harness: 'codex', root, ...await resolveScope(options), complete: true, warnings: [], unassignedCount: 0, total: 0, sessions: [] };
  }
  return withCodex({ ...options, root }, rpc => catalog({ ...options, root }, rpc));
}

async function rollout(root, session) {
  if (!session.rolloutPath) return null;
  // Native Windows APIs can return \\?\ paths even when CODEX_HOME is a normal path.
  // Compare the same namespace without resolving away symlinks before safeStat.
  const relative = path.relative(path.toNamespacedPath(root), path.toNamespacedPath(path.resolve(session.rolloutPath)));
  if (!['sessions', 'archived_sessions'].includes(relative.split(path.sep)[0])) throw fail('unsafe_path', 'Codex rollout is outside the supported local storage roots');
  const stat = await safeStat(root, relative);
  if (!stat?.isFile()) throw fail('incomplete_scan', 'Native rollout path is missing or not a regular file');
  const input = createReadStream(path.join(root, relative), { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let metadata;
  try { for await (const line of lines) { if (line.trim()) { metadata = JSON.parse(line); break; } } } finally { lines.close(); input.destroy(); }
  // payload.session_id may be the parent/root session tree. Only payload.id is the thread identity.
  if (metadata?.type !== 'session_meta' || metadata.payload?.id?.toLowerCase() !== session.id) throw fail('identity_mismatch', 'Rollout metadata does not match the native thread ID');
  return hashFile(root, relative);
}

async function fillMissingNames(root, targets, files) {
  const missing = targets.filter(item => item.nameSource === 'unnamed');
  if (!missing.length) return;
  const names = new Map(), wanted = new Set(missing.map(item => item.id));
  const stat = await safeStat(root, 'session_index.jsonl');
  if (stat?.isFile() && stat.size <= 32 * 1024 * 1024) {
    const input = createReadStream(path.join(root, 'session_index.jsonl'), { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        let row; try { row = JSON.parse(line); } catch { continue; }
        const id = typeof row.id === 'string' ? row.id.toLowerCase() : null;
        const name = clean(row.thread_name), time = Date.parse(row.updated_at || '') || 0;
        if (wanted.has(id) && name && (!names.has(id) || time >= names.get(id).time)) names.set(id, { name, time });
      }
    } finally { lines.close(); input.destroy(); }
  }
  for (const item of missing) {
    if (names.has(item.id)) { item.name = names.get(item.id).name; item.nameSource = 'session-index'; continue; }
    if (!item.rolloutPath) continue;
    const relative = path.relative(path.toNamespacedPath(root), path.toNamespacedPath(path.resolve(item.rolloutPath)));
    if (!files.some(file => file.path === relative)) continue; // Already identity/path verified by rollout().
    const handle = await fs.open(path.join(root, relative), 'r');
    try {
      const buffer = Buffer.alloc(65536), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      let label = '';
      for (const line of buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/)) {
        let row; try { row = JSON.parse(line); } catch { continue; }
        if (row.type === 'session_meta') label = clean(row.payload?.agent_nickname) || clean(row.payload?.agent_role);
        if (row.type === 'event_msg' && row.payload?.type === 'user_message' && clean(row.payload.message)) {
          label = clean(row.payload.message).slice(0, 100); break;
        }
      }
      if (label) { item.name = label; item.nameSource = 'rollout'; }
    } finally { await handle.close(); }
  }
}

async function planFor(options, rpc, selected, context) {
  const { root, scope, currentProject } = context;
  const descendants = new Map();
  for (const archived of [false, true]) {
    for (const thread of await pages(rpc, { ancestorThreadId: selected.id, sourceKinds: allSources, archived })) {
      if (thread.id === selected.id) throw fail('codex_protocol_error', 'Descendant query returned the parent');
      descendants.set(thread.id, await normalize(root, thread, archived));
    }
  }
  const targets = [selected, ...descendants.values()].sort(byRecentActivity);
  if (scope === 'current' && targets.some(item => !item.project || projectKey(item.project) !== projectKey(currentProject))) {
    throw fail('cross_project_session', 'Codex deletion cascades to descendant threads outside this project; an explicit all-project scope is required', { projects: [...new Set(targets.map(item => item.project))] });
  }
  if (targets.some(item => item.ephemeral)) throw fail('unsupported_session', 'Ephemeral threads cannot be permanently deleted by this skill');
  const files = [];
  for (const target of targets) { const file = await rollout(root, target); if (file) files.push(file); }
  await fillMissingNames(root, targets, files);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const identity = targets.map(({ id, activity, project, rolloutPath, archived }) => ({ id, activity, project, rolloutPath, archived })).sort((a, b) => a.id.localeCompare(b.id));
  const requiresActive = targets.some(item => item.activity.state === 'active');
  const requiresUnknown = targets.some(item => item.activity.state === 'unknown');
  const fingerprint = hash({ harness: 'codex', root, scope, currentProject, selectedId: selected.id, identity, files,
    metadata: targets.map(({ id, name, updatedAt, lastActiveAt }) => ({ id, name, updatedAt, lastActiveAt })).sort((a, b) => a.id.localeCompare(b.id)) });
  return { status: 'ready', harness: 'codex', root, scope, currentProject, session: selected, targets,
    descendants: targets.filter(item => item.id !== selected.id), files, fileCount: files.length, sharedRecordCount: null,
    operation: 'thread/delete', localDataPresent: true, fingerprint, identityFingerprint: hash({ harness: 'codex', root, scope, currentProject, selectedId: selected.id, identity }),
    requiresConfirmation: requiresActive ? 'active' : requiresUnknown ? 'unknown' : null, requiresActive, requiresUnknown,
    requiresDescendantConfirmation: descendants.size > 0 };
}

async function preview(options, rpc) {
  if (options.id !== undefined && !UUID.test(options.id)) throw fail('invalid_id', 'Provide a complete Codex thread UUID');
  const listing = await catalog(options, rpc);
  const context = { root: listing.root, scope: listing.scope, currentProject: listing.currentProject };
  const match = options.id ? { kind: 'exact_id', candidates: listing.sessions.filter(item => item.id === options.id.toLowerCase()) } : matchSessions(listing.sessions, options.query);
  if (!match.candidates.length) return { status: 'not_found', harness: 'codex', ...context, candidates: [] };
  if (!['exact_id', 'exact_name'].includes(match.kind)) return { status: 'selection_required', harness: 'codex', match: match.kind, ...context,
    candidates: match.candidates.map((item, index) => ({ number: index + 1, ...item })) };
  return planFor(options, rpc, match.candidates[0], context);
}

export async function previewCodexDelete(options = {}) {
  const root = await codexRoot(options.root);
  return withCodex({ ...options, root }, rpc => preview({ ...options, root }, rpc));
}

async function execute(options, rpc) {
  if (!UUID.test(options.id || '') || !/^[a-f0-9]{64}$/.test(options.expect || '')) throw fail('preview_required', 'Execution needs a full UUID and preview fingerprint');
  const plan = await preview(options, rpc);
  if (plan.status !== 'ready') throw fail('not_found', 'Selected Codex thread no longer exists in this scope');
  if (plan.fingerprint !== options.expect) throw fail('stale_preview', 'Codex target, descendants, activity or files changed', { preview: plan });
  if (plan.requiresActive && !options.allowActive) throw fail('active_confirmation_required', 'A target thread is active; ask the user before deletion', { preview: plan });
  if (plan.requiresUnknown && !options.allowUnknown) throw fail('unknown_confirmation_required', 'Activity is unknown for a target thread', { preview: plan });
  if (plan.requiresDescendantConfirmation && !options.allowDescendants) throw fail('descendant_confirmation_required', 'Native deletion includes descendant threads; confirm the displayed targets', { preview: plan });
  if (options.verifyCurrentSession) await options.verifyCurrentSession();
  try { await rpc.call('thread/delete', { threadId: plan.session.id }); } catch (error) {
    // A lost or malformed response can occur after a commit. Never retry automatically.
    throw fail(error.code || 'codex_delete_failed', error.message, { ...error.details,
      deletionMayHaveCompleted: ['codex_timeout', 'codex_disconnected', 'codex_protocol_error'].includes(error.code) || error.details?.rpcCode === -32603,
      targetIds: plan.targets.map(item => item.id) });
  }
  const remaining = [], errors = [];
  let persisted;
  try {
    persisted = new Set();
    for (const archived of [false, true]) {
      for (const thread of await pages(rpc, { archived, sourceKinds: allSources })) persisted.add(thread.id);
    }
  } catch (error) { persisted = null; errors.push({ code: error.code, message: error.message }); }
  for (const item of plan.targets) {
    if (persisted?.has(item.id)) remaining.push(item.id);
    try { const response = await rpc.call('thread/read', { threadId: item.id, includeTurns: false }); if (response?.thread) remaining.push(item.id); }
    catch (error) {
      // A missing persisted thread can report "thread not loaded". This message alone
      // does not prove deletion; also require a complete native list and absent files.
      if (!/not found|no rollout|does not exist|unknown thread|unable to find|failed to find|thread not loaded/i.test(error.message)) {
        errors.push({ id: item.id, code: error.code, message: error.message });
      }
    }
  }
  for (const file of plan.files) {
    try { if (await safeStat(plan.root, file.path)) remaining.push(file.path); }
    catch (error) { errors.push({ path: file.path, code: error.code, message: error.message }); }
  }
  return { status: errors.length || remaining.length ? 'partial' : 'deleted', harness: 'codex', id: plan.session.id, name: plan.session.name,
    scope: plan.scope, currentProject: plan.currentProject,
    deletedThreadIds: persisted ? plan.targets.map(item => item.id).filter(id => !remaining.includes(id) && !errors.some(error => error.id === id)) : [],
    deletedFiles: plan.files.filter(file => !remaining.includes(file.path) && !errors.some(error => error.path === file.path)).map(file => file.path),
    remaining: [...new Set(remaining)], errors, recoverable: false,
    runtimeStillActive: plan.requiresActive, nativeOperation: 'thread/delete' };
}

export async function executeCodexDelete(options = {}) {
  const root = await codexRoot(options.root);
  return withCodex({ ...options, root }, rpc => execute({ ...options, root }, rpc));
}

async function currentIdentity(options, rpc) {
  const env = options.runtimeEnv ?? process.env;
  const id = env.CODEX_THREAD_ID;
  if (!UUID.test(id || '') || !UUID.test(env.CODEX_SESSION_ID || '') || !env.CODEX_TOOL_CALL_ID) throw fail('current_session_unverified', 'A fresh native Codex shell tool context is required');
  if (options.currentSessionId !== 'auto' && options.currentSessionId?.toLowerCase() !== id.toLowerCase()) throw fail('current_session_mismatch', 'Expected thread differs from the current Codex thread');
  const response = await rpc.call('thread/read', { threadId: id, includeTurns: false });
  if (response?.thread?.id?.toLowerCase() !== id.toLowerCase() || response.thread.sessionId?.toLowerCase() !== env.CODEX_SESSION_ID.toLowerCase()) throw fail('current_session_mismatch', 'Codex runtime thread/session tree identity disagrees with stored metadata');
  const item = await normalize(options.root, response.thread, false);
  if (!item.rolloutPath) throw fail('current_session_unverified', 'Current thread has no verifiable local rollout');
  await rollout(options.root, item);
  // notLoaded belongs to this helper, not necessarily the user's executor; use the lock check.
  if (item.activity.state !== 'active') throw fail('current_session_unverified', 'The current Codex thread writer could not be verified as active');
  return { harness: 'codex', id: item.id, sessionTreeId: item.sessionTreeId, root: options.root };
}

async function currentPreview(options, rpc) {
  if (options.id !== undefined || options.query !== undefined) throw fail('invalid_options', 'Current-session mode is exclusive with ID/name mode');
  const identity = await currentIdentity(options, rpc);
  const plan = await preview({ ...options, id: identity.id }, rpc);
  if (plan.status !== 'ready') return { ...plan, currentSession: true };
  return { ...plan, currentSession: true, currentIdentity: identity, requiresConfirmation: 'active',
    confirmationFingerprint: hash({ identity, plan: plan.identityFingerprint }) };
}

export async function previewCurrentCodexDelete(options = {}) {
  const root = await codexRoot(options.root);
  return withCodex({ ...options, root }, rpc => currentPreview({ ...options, root }, rpc));
}

export async function executeCurrentCodexDelete(options = {}) {
  const root = await codexRoot(options.root);
  return withCodex({ ...options, root }, async rpc => {
    const fixed = { ...options, root };
    const plan = await currentPreview(fixed, rpc);
    if (plan.status !== 'ready') throw fail('not_found', 'Current Codex thread is outside the selected scope or no longer present');
    if (plan.confirmationFingerprint !== options.expect) throw fail('stale_preview', 'Current Codex identity, descendants or scope changed', { preview: plan });
    if (!options.allowActive) throw fail('active_confirmation_required', 'Current-thread deletion requires a separate active confirmation');
    return execute({ ...fixed, id: plan.session.id, expect: plan.fingerprint, verifyCurrentSession: async () => {
      if (hash(await currentIdentity(fixed, rpc)) !== hash(plan.currentIdentity)) throw fail('current_session_mismatch', 'Current Codex thread changed before deletion');
    } }, rpc);
  });
}
