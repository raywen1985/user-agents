import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { connectCodex, resolveCodexExecutable } from '../scripts/codex-rpc.mjs';
import { listCodexSessions, previewCodexDelete, executeCodexDelete, previewCurrentCodexDelete, executeCurrentCodexDelete } from '../scripts/codex-store.mjs';
import { adapters, resolveHarness, listManagedSessions, previewManagedDelete, executeManagedDelete } from '../scripts/harnesses.mjs';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
async function installedCodex(t) {
  let launch;
  try { launch = await resolveCodexExecutable({ args: ['--version'] }); }
  catch (error) { if (error.code !== 'codex_not_found') throw error; t.skip(error.message); return null; }
  const result = spawnSync(launch.command, launch.args, { ...launch.options, encoding: 'utf8' });
  assert.equal(result.status, 0, `Installed Codex failed to start: ${result.error?.message || result.stderr}`);
  return launch.executable;
}
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'session-mgr-codex-test-')));
  t.after(async () => { assert.equal(path.dirname(root), await fs.realpath(os.tmpdir())); assert.ok(path.basename(root).startsWith('session-mgr-codex-test-')); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const threads = new Map(), calls = [], pagesSeen = [];
  const project = path.join(root, 'project'); await fs.mkdir(project);
  async function add(id, { name = 'Build', cwd = project, archived = false, parentThreadId = null, recencyAt = 100, sessionId = id } = {}) {
    const rollout = path.join(root, archived ? 'archived_sessions' : 'sessions/2026/10/30', `rollout-2026-10-30T00-00-00-${id}.jsonl`);
    await fs.mkdir(path.dirname(rollout), { recursive: true });
    await fs.writeFile(rollout, JSON.stringify({ type: 'session_meta', timestamp: '2026-10-30T00:00:00Z', payload: {
      id, timestamp: '2026-10-30T00:00:00Z', cwd, source: 'cli', originator: 'codex_cli_rs', cli_version: '0.164.0', model_provider: 'openai',
    } }) + '\n' + JSON.stringify({ type: 'event_msg', timestamp: '2026-10-30T00:00:01Z', payload: { type: 'user_message', message: name } }) + '\n');
    threads.set(id, { id, sessionId, name, cwd, archived, parentThreadId, path: rollout, recencyAt, updatedAt: recencyAt,
      createdAt: 1, preview: name, status: { type: 'notLoaded' }, source: parentThreadId ? { subagent: 'thread_spawn' } : 'cli', ephemeral: false });
  }
  const rpc = { async call(method, params) {
    calls.push({ method, params });
    if (method === 'thread/list') {
      const isDescendant = item => { let parent = item.parentThreadId; const seen = new Set(); while (parent && !seen.has(parent)) { if (parent === params.ancestorThreadId) return true; seen.add(parent); parent = threads.get(parent)?.parentThreadId; } return false; };
      const items = [...threads.values()].filter(item => item.archived === params.archived && (params.ancestorThreadId ? isDescendant(item) : !item.parentThreadId));
      const offset = Number(params.cursor || 0); pagesSeen.push({ ...params });
      return { data: items.slice(offset, offset + 1), nextCursor: offset + 1 < items.length ? String(offset + 1) : null };
    }
    if (method === 'thread/read') { if (!threads.has(params.threadId)) throw new Error('thread not found'); return { thread: threads.get(params.threadId) }; }
    if (method === 'thread/delete') {
      const doomed = new Set([params.threadId]); let changed;
      do { changed = false; for (const item of threads.values()) if (doomed.has(item.parentThreadId) && !doomed.has(item.id)) { doomed.add(item.id); changed = true; } } while (changed);
      for (const id of doomed) { const item = threads.get(id); if (item) { await fs.unlink(item.path); threads.delete(id); } }
      return {};
    }
    throw new Error(`Unexpected method ${method}`);
  } };
  return { root, project, threads, calls, pagesSeen, add, rpc, options: { root, scope: 'all', rpc } };
}

test('Codex lists every page, archived and normal threads, and scopes and sorts them uniformly', async t => {
  const f = await fixture(t); await f.add(A, { name: 'Build older', recencyAt: 1 });
  await f.add(B, { name: 'Buid', recencyAt: 3 }); await f.add(C, { archived: true, cwd: path.join(f.root, 'other'), recencyAt: 2 });
  const all = await listCodexSessions(f.options);
  assert.deepEqual(all.sessions.map(x => x.id), [B, C, A]); assert.equal(all.complete, true);
  assert.ok(f.pagesSeen.some(x => x.cursor === '1')); assert.ok(f.pagesSeen.some(x => x.archived));
  const local = await listCodexSessions({ root: f.root, rpc: f.rpc, project: f.project });
  assert.deepEqual(local.sessions.map(x => x.id), [B, A]);
  const candidates = await previewCodexDelete({ root: f.root, rpc: f.rpc, project: f.project, query: 'build' });
  assert.equal(candidates.status, 'selection_required'); assert.deepEqual(candidates.candidates.map(x => x.id), [B, A]);
  assert.equal((await previewCodexDelete({ root: f.root, rpc: f.rpc, project: f.project, id: C })).status, 'not_found');
  assert.equal(f.calls.some(x => x.method === 'thread/delete'), false);
});

test('Codex native deletion preserves unrelated threads and requires a fresh preview', async t => {
  const f = await fixture(t); await f.add(A); await f.add(B);
  const preview = await previewCodexDelete({ ...f.options, id: A });
  await fs.appendFile(f.threads.get(A).path, '\n');
  await assert.rejects(executeCodexDelete({ ...f.options, id: A, expect: preview.fingerprint }), { code: 'stale_preview' });
  assert.equal(f.calls.some(x => x.method === 'thread/delete'), false);
  const fresh = await previewCodexDelete({ ...f.options, id: A });
  const result = await executeCodexDelete({ ...f.options, id: A, expect: fresh.fingerprint });
  assert.equal(result.status, 'deleted'); assert.deepEqual(result.deletedThreadIds, [A]); assert.ok(f.threads.has(B));
});

test('Codex cascades are previewed, cross-project restricted and separately confirmed', async t => {
  const f = await fixture(t); await f.add(A); await f.add(B, { parentThreadId: A, cwd: path.join(f.root, 'other'), archived: true }); await f.add(C);
  await assert.rejects(previewCodexDelete({ root: f.root, rpc: f.rpc, project: f.project, id: A }), { code: 'cross_project_session' });
  const preview = await previewCodexDelete({ ...f.options, id: A });
  assert.deepEqual(preview.descendants.map(x => x.id), [B]);
  await assert.rejects(executeCodexDelete({ ...f.options, id: A, expect: preview.fingerprint }), { code: 'descendant_confirmation_required' });
  assert.equal(f.calls.some(x => x.method === 'thread/delete'), false);
  const result = await executeCodexDelete({ ...f.options, id: A, expect: preview.fingerprint, allowDescendants: true });
  assert.equal(result.status, 'deleted'); assert.deepEqual(new Set(result.deletedThreadIds), new Set([A, B])); assert.ok(f.threads.has(C));
});

test('deletion previews recover unnamed descendants from the name index and verified rollout', async t => {
  const f = await fixture(t); await f.add(A); await f.add(B, { parentThreadId: A, name: 'Rollout child' });
  await f.add(C, { parentThreadId: A, name: 'Rollout fallback' });
  for (const id of [B, C]) { f.threads.get(id).name = ''; f.threads.get(id).preview = ''; }
  await fs.writeFile(path.join(f.root, 'session_index.jsonl'), JSON.stringify({ id: B, thread_name: 'Guardian review', updated_at: '2026-10-30T00:00:00Z' }) + '\n');
  const plan = await previewCodexDelete({ ...f.options, id: A });
  assert.equal(plan.descendants.find(item => item.id === B).name, 'Guardian review');
  assert.equal(plan.descendants.find(item => item.id === C).name, 'Rollout fallback');
  assert.equal(f.calls.some(call => call.method === 'thread/delete'), false);
});

test('Codex active and unknown states each require their own explicit confirmation', async t => {
  const f = await fixture(t); await f.add(A); f.threads.get(A).status = { type: 'idle' };
  let plan = await previewCodexDelete({ ...f.options, id: A });
  await assert.rejects(executeCodexDelete({ ...f.options, id: A, expect: plan.fingerprint }), { code: 'active_confirmation_required' });
  f.threads.get(A).status = { type: 'systemError' };
  plan = await previewCodexDelete({ ...f.options, id: A });
  await assert.rejects(executeCodexDelete({ ...f.options, id: A, expect: plan.fingerprint, allowActive: true }), { code: 'unknown_confirmation_required' });
  assert.equal((await executeCodexDelete({ ...f.options, id: A, expect: plan.fingerprint, allowUnknown: true })).status, 'deleted');
});

test('a newly spawned descendant invalidates both ordinary and current confirmations', async t => {
  const f = await fixture(t); await f.add(A); f.threads.get(A).status = { type: 'idle' };
  const options = { ...f.options, currentSessionId: 'auto', runtimeEnv: { CODEX_THREAD_ID: A, CODEX_SESSION_ID: A, CODEX_TOOL_CALL_ID: 'tool-A' } };
  const ordinary = await previewCodexDelete({ ...f.options, id: A });
  const current = await previewCurrentCodexDelete(options);
  await f.add(B, { parentThreadId: A });
  await assert.rejects(executeCodexDelete({ ...f.options, id: A, expect: ordinary.fingerprint, allowActive: true, allowDescendants: true }), { code: 'stale_preview' });
  await assert.rejects(executeCurrentCodexDelete({ ...options, expect: current.confirmationFingerprint, allowActive: true, allowDescendants: true }), { code: 'stale_preview' });
  assert.equal(f.calls.some(x => x.method === 'thread/delete'), false);
});

test('Codex refuses mismatched rollout identity, out-of-root paths and junctions', async t => {
  const f = await fixture(t); await f.add(A); await f.add(B);
  f.threads.get(A).path = path.toNamespacedPath(f.threads.get(A).path);
  assert.equal((await previewCodexDelete({ ...f.options, id: A })).status, 'ready');
  f.threads.get(A).path = f.threads.get(B).path;
  await assert.rejects(previewCodexDelete({ ...f.options, id: A }), { code: 'identity_mismatch' });
  f.threads.get(A).path = path.join(f.root, 'outside.jsonl');
  await assert.rejects(previewCodexDelete({ ...f.options, id: A }), { code: 'unsafe_path' });
  await fs.symlink(path.dirname(f.threads.get(B).path), path.join(f.root, 'sessions/link'), process.platform === 'win32' ? 'junction' : 'dir');
  f.threads.get(A).path = path.join(f.root, 'sessions/link', path.basename(f.threads.get(B).path));
  await assert.rejects(previewCodexDelete({ ...f.options, id: A }), { code: 'unsafe_path' });
  assert.equal(f.calls.some(x => x.method === 'thread/delete'), false);
});

test('Codex resume A then B refuses stale identity and authorization; tree ID never replaces thread ID', async t => {
  const f = await fixture(t); await f.add(A); await f.add(B, { sessionId: A });
  f.threads.get(A).status = f.threads.get(B).status = { type: 'idle' };
  const envA = { CODEX_THREAD_ID: A, CODEX_SESSION_ID: A, CODEX_TOOL_CALL_ID: 'tool-A' };
  const envB = { CODEX_THREAD_ID: B, CODEX_SESSION_ID: A, CODEX_TOOL_CALL_ID: 'tool-B' };
  const base = { ...f.options, currentSessionId: 'auto' };
  const before = await previewCurrentCodexDelete({ ...base, runtimeEnv: envA });
  await assert.rejects(previewCurrentCodexDelete({ ...base, runtimeEnv: envB, currentSessionId: A }), { code: 'current_session_mismatch' });
  await assert.rejects(executeCurrentCodexDelete({ ...base, runtimeEnv: envB, expect: before.confirmationFingerprint, allowActive: true }), { code: 'stale_preview' });
  await assert.rejects(previewCurrentCodexDelete({ ...base, runtimeEnv: {} }), { code: 'current_session_unverified' });
  const now = await previewCurrentCodexDelete({ ...base, runtimeEnv: envB }); assert.equal(now.session.id, B);
  await assert.rejects(executeCurrentCodexDelete({ ...base, runtimeEnv: envB, expect: now.confirmationFingerprint }), { code: 'active_confirmation_required' });
  const done = await executeCurrentCodexDelete({ ...base, runtimeEnv: envB, expect: now.confirmationFingerprint, allowActive: true });
  assert.equal(done.status, 'deleted'); assert.ok(f.threads.has(A));
});

test('Codex reports surviving data and never retries a failed native deletion', async t => {
  const f = await fixture(t); await f.add(A);
  const original = f.rpc.call;
  f.rpc.call = async (method, params) => method === 'thread/delete' ? {} : original(method, params);
  const plan = await previewCodexDelete({ ...f.options, id: A });
  assert.equal((await executeCodexDelete({ ...f.options, id: A, expect: plan.fingerprint })).status, 'partial');
  for (const code of ['codex_disconnected', 'codex_timeout', 'codex_protocol_error']) {
    let attempts = 0;
    f.rpc.call = async (method, params) => { if (method === 'thread/delete') { attempts++; throw Object.assign(new Error('Response unavailable'), { code }); } return original(method, params); };
    await assert.rejects(executeCodexDelete({ ...f.options, id: A, expect: plan.fingerprint }), error => error.code === code && error.details.deletionMayHaveCompleted);
    assert.equal(attempts, 1);
  }
});

test('harness routing rejects ambiguity and unimplemented providers; fingerprints bind the harness', async t => {
  assert.equal(resolveHarness(undefined, { CODEX_THREAD_ID: A }), 'codex');
  assert.equal(resolveHarness(undefined, { CLAUDE_CODE_SESSION_ID: A, CLAUDE_PID: '1' }), 'claude');
  assert.throws(() => resolveHarness(undefined, {}), { code: 'harness_required' });
  assert.throws(() => resolveHarness(undefined, { CODEX_THREAD_ID: A, CLAUDE_CODE_SESSION_ID: B, CLAUDE_PID: '1' }), { code: 'harness_required' });
  assert.throws(() => resolveHarness('opencode'), { code: 'unsupported_harness' });
  const f = await fixture(t); await f.add(A);
  const options = { ...f.options, harness: 'codex', id: A };
  const raw = await previewCodexDelete(options), bound = await previewManagedDelete(options);
  assert.notEqual(raw.fingerprint, bound.fingerprint);
  await assert.rejects(executeManagedDelete({ ...options, expect: raw.fingerprint }), { code: 'stale_preview' });
  f.threads.get(A).status = { type: 'idle' };
  const active = await previewManagedDelete(options);
  await assert.rejects(executeManagedDelete({ ...options, expect: active.fingerprint }), error => error.code === 'active_confirmation_required' && error.details.preview.fingerprint === active.fingerprint);
  f.threads.get(A).status = { type: 'notLoaded' };
  assert.equal((await executeManagedDelete({ ...options, expect: bound.fingerprint })).status, 'deleted');
});

test('all-harness lists keep duplicate IDs, sort globally, and never hide an incomplete provider', async t => {
  const saved = { claude: adapters.claude.list, codex: adapters.codex.list };
  t.after(() => { adapters.claude.list = saved.claude; adapters.codex.list = saved.codex; });
  const entry = (id, time) => ({ id, name: 'Build', lastActiveAt: time, activity: { state: 'inactive' } });
  const listing = sessions => ({ complete: true, warnings: [], unassignedCount: 0, total: sessions.length, sessions });
  adapters.claude.list = async () => listing([entry(A, '2026-10-01T00:00:00Z'), entry(B, null)]);
  adapters.codex.list = async () => listing([entry(A, '2026-10-02T00:00:00Z')]);
  const result = await listManagedSessions({ harness: 'all', scope: 'all' });
  assert.deepEqual(result.sessions.map(x => [x.harness, x.id]), [['codex', A], ['claude', A], ['claude', B]]);
  const candidates = await previewManagedDelete({ harness: 'all', scope: 'all', id: A });
  assert.equal(candidates.status, 'selection_required'); assert.equal(candidates.candidates.length, 2);
  await assert.rejects(executeManagedDelete({ harness: 'all', id: A, expect: '0'.repeat(64) }), { code: 'harness_required' });
  adapters.codex.list = async () => { throw new Error('Codex unavailable'); };
  const partial = await listManagedSessions({ harness: 'all', scope: 'all' });
  assert.equal(partial.complete, false); assert.equal(partial.total, 2); assert.match(partial.warnings[0], /codex.*unavailable/);
  await assert.rejects(previewManagedDelete({ harness: 'all', scope: 'all', id: A }), { code: 'incomplete_scan' });
});

test('installed Codex native API deletes only disposable fixture data', async t => {
  const executable = await installedCodex(t); if (!executable) return;
  const f = await fixture(t); await f.add(A, { name: 'Native target' }); await f.add(B, { name: 'Native keep' });
  const rpc = await connectCodex({ root: f.root, codexBin: executable, timeoutMs:15000 });
  try {
    const options = { root: f.root, scope: 'all', rpc };
    const listed = await listCodexSessions(options); assert.equal(listed.total, 2);
    const plan = await previewCodexDelete({ ...options, id: A }); assert.equal(plan.status, 'ready');
    const result = await executeCodexDelete({ ...options, id: A, expect: plan.fingerprint });
    assert.equal(result.status, 'deleted', JSON.stringify(result));
    const after = await listCodexSessions(options); assert.deepEqual(after.sessions.map(x => x.id), [B]);
  } finally { await rpc.close(); }
});

test('native Codex detects another live writer and preserves its data when deletion is refused', async t => {
  const executable = await installedCodex(t); if (!executable) return;
  const f = await fixture(t); await f.add(A); await f.add(B);
  const owner = await connectCodex({ root: f.root, codexBin: executable, timeoutMs: 15000 });
  let helper;
  try {
    // Load only a disposable fixture; never start a model turn or touch real sessions.
    await owner.call('thread/resume', { threadId: A, cwd: f.project, approvalPolicy: 'never' });
    helper = await connectCodex({ root: f.root, codexBin: executable, timeoutMs: 15000 });
    const options = { root: f.root, scope: 'all', id: A, rpc: helper };
    const plan = await previewCodexDelete(options);
    assert.equal(plan.session.activity.state, process.platform === 'win32' ? 'active' : 'unknown');
    await assert.rejects(executeCodexDelete({ ...options, expect: plan.fingerprint, allowActive: true, allowUnknown: true }), error => error.code === 'codex_rpc_error' && /active writer/.test(error.message));
    assert.deepEqual(new Set((await listCodexSessions(options)).sessions.map(x => x.id)), new Set([A, B]));
    await fs.access(f.threads.get(A).path);
  } finally { if (helper) await helper.close(); await owner.close(); }
});
