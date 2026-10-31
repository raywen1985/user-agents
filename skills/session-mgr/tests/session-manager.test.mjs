import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultRoot, executeDelete, listSessions, matchSessions, previewDelete, probeProcesses } from '../scripts/session-store.mjs';
import { executeCurrentSessionDelete, previewCurrentSessionDelete } from '../scripts/current-session.mjs';
import { resolveCurrentRuntime } from '../scripts/current-runtime.mjs';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const inactive = async records => records.map(item => ({ key: item.key, state: 'inactive' }));
const active = async records => records.map(item => ({ key: item.key, state: 'active' }));
const cli = fileURLToPath(new URL('../scripts/session-manager.mjs', import.meta.url));

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'claude-session-manager-test-')));
  t.after(async () => {
    // Only remove the exact mkdtemp directory created by this test.
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('claude-session-manager-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const put = async (relative, content) => {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, typeof content === 'string' ? content : JSON.stringify(content));
  };
  const session = async (id, name, project = 'demo') => {
    await fs.mkdir(path.join(root, 'source', project), { recursive: true });
    await put(`projects/${project}/${id}.jsonl`, JSON.stringify({ type: 'user', sessionId: id,
      cwd: path.join(root, 'source', project), timestamp: '2026-10-20T12:00:00Z', message: { content: `Prompt for ${name}` } }) + '\n');
    if (name) await put(`projects/${project}/${id}/custom-title.json`, { customTitle: name });
  };
  const current = async (id = A) => {
    await put('sessions/9001.json', { pid: 9001, sessionId: id, procStart: '1234567890123456' });
    return { runtimeEnv: { CLAUDE_CODE_SESSION_ID: id, CLAUDE_PID: '9001' }, probeCurrent: async () => true };
  };
  return { root, put, session, current, options: { root, scope: 'all', probe: inactive }, exists: async relative => {
    try { await fs.lstat(path.join(root, relative)); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  } };
}

test('lists all projects, merges history/index/runtime by ID, includes unnamed and index-only sessions', async t => {
  const f = await fixture(t);
  await f.session(A, '构建修复', 'first'); await f.session(B, '', 'second');
  await f.put('projects/first/sessions-index.json', { version: 1, entries: [{ sessionId: A, summary: 'Old title' }, { sessionId: C, customTitle: 'Index only' }] });
  await f.put('history.jsonl', JSON.stringify({ sessionId: A, display: 'Earlier prompt', project: '/sample', timestamp: 1 }) + '\n');
  await f.put('sessions/1.json', { sessionId: A, pid: 1, name: 'Stale runtime title' });
  const result = await listSessions(f.options);
  assert.equal(result.total, 3); assert.equal(result.complete, true);
  assert.equal(result.sessions.find(item => item.id === A).name, '构建修复');
  assert.equal(result.sessions.find(item => item.id === B).nameSource, 'first-prompt');
  assert.equal(result.sessions.find(item => item.id === C).name, 'Index only');
});

test('fuzzy single candidate and duplicate exact names require selection; complete ID is authoritative', async t => {
  const f = await fixture(t);
  await f.session(A, 'Build Pipeline'); await f.session(B, 'Build Pipeline'); await f.session(C, '中文排查');
  const duplicate = await previewDelete({ ...f.options, query: 'build pipeline' });
  assert.equal(duplicate.status, 'selection_required'); assert.equal(duplicate.candidates.length, 2);
  const fuzzy = await previewDelete({ ...f.options, query: '中文' });
  assert.equal(fuzzy.status, 'selection_required'); assert.equal(fuzzy.candidates.length, 1);
  assert.equal((await previewDelete({ ...f.options, query: A.slice(0, 8) })).status, 'selection_required');
  assert.equal((await previewDelete({ ...f.options, query: A })).status, 'ready');
  assert.equal((await previewDelete({ ...f.options, query: '中文排查' })).status, 'ready');
  assert.equal((await previewDelete({ ...f.options, query: 'completely unrelated' })).status, 'not_found');
  assert.equal(matchSessions([{ id: A, name: 'Build Pipeline' }], 'Buid Pipeline').kind, 'fuzzy');
});

test('all list and candidate routes sort by recent activity and preserve candidate number-to-ID mapping', async t => {
  const f = await fixture(t);
  for (const [id, name, project, timestamp] of [
    [A, 'Build old', 'demo', '2026-10-01T12:00:00Z'],
    [B, 'Buid', 'demo', '2026-10-03T12:00:00Z'],
    [C, 'Build middle', 'other', '2026-10-02T12:00:00Z'],
  ]) {
    await f.session(id, name, project);
    await f.put(`projects/${project}/${id}.jsonl`, JSON.stringify({ type: 'user', sessionId: id,
      cwd: path.join(f.root, 'source', project), timestamp, message: { content: name } }) + '\n');
  }
  // Copying the oldest transcript or changing its title must not make it newest.
  const copiedAt = new Date('2030-01-01T00:00:00Z');
  await fs.utimes(path.join(f.root, `projects/demo/${A}.jsonl`), copiedAt, copiedAt);
  await f.put('sessions/9.json', { sessionId: A, pid: 9, statusUpdatedAt: Date.parse('2026-10-01T13:00:00Z'),
    updatedAt: Date.parse('2026-10-05T00:00:00Z') });
  const options = { ...f.options, probe: active };
  const all = await listSessions(options);
  assert.deepEqual(all.sessions.map(item => item.id), [B, C, A]);
  assert.equal(all.sessions[2].activity.state, 'active');
  assert.equal(all.sessions[2].lastActiveAt, '2026-10-01T13:00:00.000Z');
  const current = await listSessions({ root: f.root, project: path.join(f.root, 'source/demo'), probe: active });
  assert.deepEqual(current.sessions.map(item => item.id), [B, A]);
  // B is only a spelling match, while A/C contain the whole query.
  const match = matchSessions([...all.sessions].reverse(), 'build');
  assert.deepEqual(match.candidates.map(item => item.id), [B, C, A]);
  const selection = await previewDelete({ ...options, query: 'build' });
  assert.equal(selection.status, 'selection_required');
  assert.deepEqual(selection.candidates.map(({ number, id }) => [number, id]), [[1, B], [2, C], [3, A]]);
  const filtered = spawnSync(process.execPath, [cli, '--harness', 'claude', 'list', '--root', f.root, '--scope', 'all', '--query', 'build'], { encoding: 'utf8' });
  assert.equal(filtered.status, 0);
  assert.deepEqual(JSON.parse(filtered.stdout).sessions.map(item => item.id), [B, C, A]);
});

test('preview never mutates; delete removes only owned files and exact shared records', async t => {
  const f = await fixture(t);
  await f.session(A, 'Delete me'); await f.session(B, 'Keep me');
  await f.put(`projects/demo/${A}/subagents/agent-test.jsonl`, 'subagent data');
  for (const family of ['file-history', 'session-env', 'tasks']) {
    await f.put(`${family}/${A}/record`, 'target'); await f.put(`${family}/${B}/record`, 'keep');
  }
  await f.put(`todos/${A}-agent-${A}.json`, []); await f.put(`debug/${A}.txt`, 'debug');
  await f.put(`projects/demo/memory/${A}.md`, 'shared memory');
  await f.put(`plans/${A}.md`, 'unproven ownership'); await f.put('settings.json', { theme: 'keep' });
  const keep = JSON.stringify({ sessionId: B, display: `Reference to ${A} is not ownership` }) + '\r\n';
  await f.put('history.jsonl', JSON.stringify({ sessionId: A, display: 'delete' }) + '\n' + keep);
  await f.put('projects/demo/sessions-index.json', { version: 1, originalPath: 'keep', entries: [{ sessionId: A }, { sessionId: B, fullPath: 'do-not-follow' }] });
  const preview = await previewDelete({ ...f.options, query: 'Delete me' });
  assert.equal(preview.sharedRecordCount, 2);
  assert.equal(await f.exists(`projects/demo/${A}.jsonl`), true);
  assert.equal(preview.sharedUpdates.some(item => 'after' in item), false);
  const result = await executeDelete({ ...f.options, id: A, expect: preview.fingerprint });
  assert.equal(result.status, 'deleted'); assert.equal(result.recoverable, false);
  assert.equal(await f.exists(`projects/demo/${A}.jsonl`), false);
  assert.equal(await f.exists(`projects/demo/${A}`), false);
  for (const family of ['file-history', 'session-env', 'tasks']) {
    assert.equal(await f.exists(`${family}/${A}`), false); assert.equal(await f.exists(`${family}/${B}/record`), true);
  }
  assert.equal(await f.exists(`todos/${A}-agent-${A}.json`), false);
  assert.equal(await f.exists(`debug/${A}.txt`), false);
  assert.equal(await f.exists(`projects/demo/memory/${A}.md`), true);
  assert.equal(await f.exists(`plans/${A}.md`), true);
  assert.equal(await f.exists('settings.json'), true);
  assert.equal(await fs.readFile(path.join(f.root, 'history.jsonl'), 'utf8'), keep);
  const index = JSON.parse(await fs.readFile(path.join(f.root, 'projects/demo/sessions-index.json'), 'utf8'));
  assert.equal(index.originalPath, 'keep'); assert.deepEqual(index.entries, [{ sessionId: B, fullPath: 'do-not-follow' }]);
});

test('idle live session needs explicit active confirmation; keeps process registry', async t => {
  const f = await fixture(t); await f.session(A, 'Live');
  await f.put('sessions/9.json', { sessionId: A, pid: 9, procStart: '1234567890123456', status: 'idle', name: 'Latest runtime name', nameSince: Date.now() + 1000 });
  const options = { ...f.options, probe: active, id: A };
  const preview = await previewDelete(options);
  assert.equal(preview.session.name, 'Latest runtime name'); assert.equal(preview.requiresConfirmation, 'active');
  await assert.rejects(executeDelete({ ...options, expect: preview.fingerprint }), { code: 'active_confirmation_required' });
  assert.equal(await f.exists(`projects/demo/${A}.jsonl`), true);
  const result = await executeDelete({ ...options, expect: preview.fingerprint, allowActive: true });
  assert.equal(result.status, 'deleted'); assert.equal(result.runtimeStillActive, true);
  assert.equal(await f.exists('sessions/9.json'), true);
});

test('probe failures are unknown and cannot be overridden with allow-active', async t => {
  const f = await fixture(t); await f.session(A, 'Unknown');
  await f.put('sessions/9.json', { sessionId: A, pid: 9 });
  const options = { ...f.options, id: A, probe: async () => { throw new Error('Access denied'); } };
  const preview = await previewDelete(options);
  assert.equal(preview.requiresConfirmation, 'unknown');
  await assert.rejects(executeDelete({ ...options, expect: preview.fingerprint, allowActive: true }), { code: 'unknown_confirmation_required' });
  assert.equal((await executeDelete({ ...options, expect: preview.fingerprint, allowUnknown: true })).status, 'deleted');
});

test('malformed registry conservatively makes unrelated sessions unknown', async t => {
  const f = await fixture(t); await f.session(A, 'Unknown'); await f.put('sessions/broken.json', '{');
  const preview = await previewDelete({ ...f.options, id: A });
  assert.equal(preview.session.activity.state, 'unknown');
});

test('stale registry alone does not resurrect a deleted session, live registry is reported honestly', async t => {
  const f = await fixture(t); await f.session(A, 'Closed');
  await f.put('sessions/9.json', { sessionId: A, pid: 9 });
  const preview = await previewDelete({ ...f.options, id: A });
  await executeDelete({ ...f.options, id: A, expect: preview.fingerprint });
  assert.equal((await listSessions(f.options)).total, 0);
  const livePreview = await previewDelete({ ...f.options, id: A, probe: active });
  assert.equal(livePreview.localDataPresent, false);
  const result = await executeDelete({ ...f.options, id: A, probe: active, expect: livePreview.fingerprint, allowActive: true });
  assert.equal(result.status, 'no_local_records');
});

test('preview invalidated by later transcript writes before any deletion', async t => {
  const f = await fixture(t); await f.session(A, 'Changing');
  const preview = await previewDelete({ ...f.options, id: A });
  await fs.appendFile(path.join(f.root, `projects/demo/${A}.jsonl`), JSON.stringify({ type: 'assistant', sessionId: A }) + '\n');
  await assert.rejects(executeDelete({ ...f.options, id: A, expect: preview.fingerprint }), { code: 'stale_preview' });
  assert.equal(await f.exists(`projects/demo/${A}/custom-title.json`), true);
});

test('new active ownership invalidates preview and then requires confirmation', async t => {
  const f = await fixture(t); await f.session(A, 'Resumed');
  const before = await previewDelete({ ...f.options, id: A });
  await f.put('sessions/9.json', { sessionId: A, pid: 9 });
  const options = { ...f.options, id: A, probe: active };
  await assert.rejects(executeDelete({ ...options, expect: before.fingerprint }), { code: 'stale_preview' });
  const after = await previewDelete(options);
  await assert.rejects(executeDelete({ ...options, expect: after.fingerprint }), { code: 'active_confirmation_required' });
});

test('damaged shared history refuses execution without losing records', async t => {
  const f = await fixture(t); await f.session(A, 'Corrupt index');
  await f.put('history.jsonl', JSON.stringify({ sessionId: B }) + '\n{broken\n');
  await assert.rejects(previewDelete({ ...f.options, id: A }), { code: 'incomplete_scan' });
  assert.equal(await f.exists(`projects/demo/${A}.jsonl`), true);
});

test('paths from index data are never deletion targets', async t => {
  const f = await fixture(t); await f.session(A, 'Untrusted index');
  await f.put('source/precious.txt', 'keep');
  await f.put('projects/demo/sessions-index.json', { entries: [{ sessionId: A, fullPath: path.join(f.root, 'source/precious.txt') }] });
  const preview = await previewDelete({ ...f.options, id: A });
  assert.equal(preview.files.some(item => item.path.includes('precious')), false);
  await executeDelete({ ...f.options, id: A, expect: preview.fingerprint });
  assert.equal(await f.exists('source/precious.txt'), true);
});

test('directory junction inside target is rejected without touching outside files', async t => {
  const f = await fixture(t); await f.session(A, 'Linked'); await f.put('outside/keep.txt', 'keep');
  await fs.symlink(path.join(f.root, 'outside'), path.join(f.root, `projects/demo/${A}/linked`), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(previewDelete({ ...f.options, id: A }), { code: 'unsafe_path' });
  assert.equal(await f.exists('outside/keep.txt'), true);
});

test('hard linked history and shared index preserve the other links and their bytes', async t => {
  const f = await fixture(t); await f.session(A, 'Linked');
  await f.put(`file-history/${A}/original@v1`, 'shared history bytes');
  await fs.link(path.join(f.root, `file-history/${A}/original@v1`), path.join(f.root, 'saved-history-copy'));
  await fs.link(path.join(f.root, `projects/demo/${A}.jsonl`), path.join(f.root, 'hardlink.jsonl'));
  const original = JSON.stringify({ sessionId: A }) + '\n';
  await f.put('history.jsonl', original);
  await fs.link(path.join(f.root, 'history.jsonl'), path.join(f.root, 'saved-history-index'));
  const preview = await previewDelete({ ...f.options, id: A });
  assert.equal((await executeDelete({ ...f.options, id: A, expect: preview.fingerprint })).status, 'deleted');
  assert.equal(await f.exists(`projects/demo/${A}.jsonl`), false);
  assert.equal(await f.exists('hardlink.jsonl'), true);
  assert.equal(await fs.readFile(path.join(f.root, 'saved-history-copy'), 'utf8'), 'shared history bytes');
  assert.equal(await fs.readFile(path.join(f.root, 'saved-history-index'), 'utf8'), original);
  assert.equal(await fs.readFile(path.join(f.root, 'history.jsonl'), 'utf8'), '');
});

test('linked project parent is rejected', async t => {
  const f = await fixture(t); await f.session(A, 'Linked project');
  await fs.mkdir(path.join(f.root, 'elsewhere'));
  await fs.symlink(path.join(f.root, 'elsewhere'), path.join(f.root, 'projects/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await listSessions(f.options)).complete, false);
});

test('execution requires exact UUID and fresh preview; lock prevents simultaneous deletion', async t => {
  const f = await fixture(t); await f.session(A, 'Exact only');
  await assert.rejects(executeDelete({ ...f.options, id: '../projects' }), { code: 'preview_required' });
  await assert.rejects(executeDelete({ ...f.options, id: A }), { code: 'preview_required' });
  const preview = await previewDelete({ ...f.options, id: A });
  await f.put('.session-manager-delete.lock', { pid: process.pid });
  await assert.rejects(executeDelete({ ...f.options, id: A, expect: preview.fingerprint }), { code: 'locked' });
});

test('partial deletion reports committed shared change and remaining files', async t => {
  const f = await fixture(t); await f.session(A, 'Partial');
  await f.put('history.jsonl', JSON.stringify({ sessionId: A }) + '\n');
  const preview = await previewDelete({ ...f.options, id: A });
  const originalUnlink = fs.unlink;
  t.after(() => { fs.unlink = originalUnlink; });
  fs.unlink = async file => {
    if (file === path.join(f.root, `projects/demo/${A}.jsonl`)) throw Object.assign(new Error('File is in use'), { code: 'EBUSY' });
    return originalUnlink(file);
  };
  const result = await executeDelete({ ...f.options, id: A, expect: preview.fingerprint });
  assert.equal(result.status, 'partial'); assert.equal(result.updatedShared.length, 1);
  assert.ok(result.remaining.includes(path.join('projects', 'demo', `${A}.jsonl`)));
  assert.equal(result.errors[0].code, 'EBUSY');
  fs.unlink = originalUnlink;
});

test('CLI does not execute fuzzy deletion, and respects root environment and portable home', async t => {
  const f = await fixture(t); await f.session(A, 'CLI demo');
  const call = args => spawnSync(process.execPath, [cli, '--harness', 'claude', ...args], {
    cwd: path.join(f.root, 'source/demo'), encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: f.root },
  });
  const list = call(['list']); assert.equal(list.status, 0); assert.equal(JSON.parse(list.stdout).total, 1);
  const fuzzy = call(['delete', '--query', 'demo']); assert.equal(JSON.parse(fuzzy.stdout).status, 'selection_required');
  const unsafe = call(['delete', '--query', 'demo', '--execute']); assert.equal(unsafe.status, 1);
  assert.equal(await f.exists(`projects/demo/${A}.jsonl`), true);
  assert.equal(defaultRoot('~/.claude'), path.join(os.homedir(), '.claude'));
});

test('CLI defaults to caller project for list, fuzzy and exact lookup, preview and execution', async t => {
  const f = await fixture(t);
  await f.session(A, 'Same name', 'first'); await f.session(B, 'Same name', 'second');
  const cwd = path.join(f.root, 'source/first');
  const call = args => {
    const result = spawnSync(process.execPath, [cli, '--harness', 'claude', ...args, '--root', f.root], { cwd, encoding: 'utf8' });
    return { code: result.status, ...JSON.parse(result.stdout) };
  };
  const current = call(['list']);
  assert.equal(current.scope, 'current'); assert.equal(current.currentProject, cwd);
  assert.deepEqual(current.sessions.map(item => item.id), [A]);
  assert.equal(call(['list', '--scope', 'all']).total, 2);
  assert.equal(call(['list', '--scope', 'current']).total, 1);
  assert.equal(call(['list', '--query', B]).total, 0);
  const fuzzy = call(['delete', '--query', 'Same']);
  assert.equal(fuzzy.status, 'selection_required'); assert.deepEqual(fuzzy.candidates.map(item => item.id), [A]);
  const preview = call(['delete', '--query', 'Same name']);
  assert.equal(preview.status, 'ready'); assert.equal(preview.session.id, A);
  assert.equal(call(['delete', '--query', 'Same name', '--scope', 'all']).candidates.length, 2);
  assert.equal(call(['delete', '--id', B]).status, 'not_found');
  const otherPreview = call(['delete', '--id', B, '--scope', 'all']);
  assert.equal(call(['delete', '--id', B, '--expect', otherPreview.fingerprint, '--execute']).code, 'not_found');
  const deleted = call(['delete', '--id', A, '--expect', preview.fingerprint, '--execute']);
  assert.equal(deleted.status, 'deleted'); assert.equal(deleted.scope, 'current');
  assert.equal(await f.exists(`projects/second/${B}.jsonl`), true);
  const deletedOther = call(['delete', '--id', B, '--scope', 'all', '--expect', otherPreview.fingerprint, '--execute']);
  assert.equal(deletedOther.status, 'deleted'); assert.equal(deletedOther.scope, 'all');
});

test('explicit project path survives runner cwd changes; normalizes aliases, separators and case', async t => {
  const f = await fixture(t); await f.session(A, 'Project paths', 'space  name');
  const project = path.join(f.root, 'source', 'space  name');
  const alias = path.join(f.root, 'project-alias');
  await fs.symlink(project, alias, process.platform === 'win32' ? 'junction' : 'dir');
  for (const candidate of [project + path.sep, alias, ...(process.platform === 'win32' ? [project.toUpperCase().replaceAll('\\', '/')] : [])]) {
    const result = await listSessions({ root: f.root, project: candidate, probe: inactive });
    assert.equal(result.scope, 'current'); assert.equal(result.total, 1);
  }
  const fromSkill = spawnSync(process.execPath, [cli, '--harness', 'claude', 'list', '--root', f.root, '--project', project], { encoding: 'utf8' });
  assert.equal(JSON.parse(fromSkill.stdout).total, 1);
  assert.equal((await listSessions({ root: f.root, project: path.join(project, 'subdirectory'), probe: inactive })).total, 0);
});

test('metadata from history, index and live registry determines scope; unknown projects stay in all', async t => {
  const f = await fixture(t);
  const project = path.join(f.root, 'source/demo');
  await f.put('history.jsonl', JSON.stringify({ sessionId: A, project, display: 'History only' }) + '\n');
  await f.put('projects/demo/sessions-index.json', { originalPath: project, entries: [{ sessionId: B, customTitle: 'Index only' }] });
  await f.put('sessions/9.json', { sessionId: C, pid: 9, cwd: project, name: 'Live only' });
  const result = await listSessions({ root: f.root, project, probe: active });
  assert.equal(result.total, 3);
  await f.put('projects/demo/sessions-index.json', { entries: [{ sessionId: B, customTitle: 'Unknown project' }] });
  const current = await listSessions({ root: f.root, project, probe: active });
  assert.equal(current.total, 2); assert.equal(current.unassignedCount, 1);
  assert.equal((await listSessions({ ...f.options, probe: active })).total, 3);
});

test('scope cannot silently change between preview and execution', async t => {
  const f = await fixture(t); await f.session(A, 'Scope binding');
  const current = { root: f.root, project: path.join(f.root, 'source/demo'), probe: inactive, id: A };
  const local = await previewDelete(current);
  await assert.rejects(executeDelete({ ...f.options, id: A, expect: local.fingerprint }), { code: 'stale_preview' });
  const all = await previewDelete({ ...f.options, id: A });
  await assert.rejects(executeDelete({ ...current, expect: all.fingerprint }), { code: 'stale_preview' });
  assert.equal(await f.exists(`projects/demo/${A}.jsonl`), true);
  await assert.rejects(listSessions({ ...f.options, scope: 'everywhere' }), { code: 'invalid_scope' });
  await assert.rejects(listSessions({ ...f.options, project: current.project }), { code: 'invalid_scope' });
});

test('same ID across projects cannot cause current-scope deletion to touch another project', async t => {
  const f = await fixture(t); await f.session(A, 'Shared ID', 'first'); await f.session(A, 'Shared ID', 'second');
  const current = { root: f.root, project: path.join(f.root, 'source/first'), id: A, probe: inactive };
  assert.equal((await listSessions(current)).total, 1);
  await assert.rejects(previewDelete(current), { code: 'cross_project_session' });
  const all = await previewDelete({ ...f.options, id: A });
  assert.equal((await executeDelete({ ...f.options, id: A, expect: all.fingerprint })).status, 'deleted');
  assert.equal(await f.exists(`projects/first/${A}.jsonl`), false);
  assert.equal(await f.exists(`projects/second/${A}.jsonl`), false);
});

test('historical cd paths do not change record ownership or block deletion from the stored project', async t => {
  const f = await fixture(t); await f.session(A, 'Visited paths'); await f.session(B, 'Keep');
  const project = path.join(f.root, 'source/demo'), visited = path.join(f.root, 'skills/session-mgr');
  const file = path.join(f.root, `projects/demo/${A}.jsonl`);
  await fs.appendFile(file, [path.join(project, 'Assets/ULibs'), visited].map(cwd => JSON.stringify({ type: 'user', sessionId: A, cwd })).join('\n') + '\n');
  const current = { root: f.root, project, id: A, probe: inactive };
  let plan = await previewDelete(current);
  assert.equal(plan.status, 'ready'); assert.deepEqual(plan.session.recordProjects, [project]);
  assert.ok(plan.session.projects.includes(visited));
  await assert.rejects(previewDelete({ ...current, project: visited }), { code: 'cross_project_session' });
  // Explicit index ownership also wins over the first transcript cwd.
  await f.put('projects/demo/sessions-index.json', { originalPath: project, entries: [{ sessionId: A, projectPath: project }] });
  const content = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, JSON.stringify({ type: 'system', sessionId: A, cwd: visited }) + '\n' + content);
  plan = await previewDelete(current); assert.equal(plan.status, 'ready');
  assert.equal((await executeDelete({ ...current, expect: plan.fingerprint })).status, 'deleted');
  assert.equal(await f.exists(`projects/demo/${B}.jsonl`), true);
});

test('CLI query and empty results share the list envelope; missing command fails while help succeeds', async t => {
  const f = await fixture(t); await f.session(A, 'Build');
  const call = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', windowsHide: true });
  const base = ['list', '--harness', 'claude', '--root', f.root, '--scope', 'all'];
  const all = JSON.parse(call(base).stdout), none = JSON.parse(call([...base, '--query', 'no-such-name']).stdout);
  assert.deepEqual(Object.keys(none), Object.keys(all)); assert.equal(none.total, 0); assert.equal(none.totalUnfiltered, 1);
  assert.equal(call([]).status, 1); assert.equal(call(['--help']).status, 0);
});

test('real process probe recognizes a live process and rejects a reused Windows PID identity', async () => {
  const result = await probeProcesses([{ key: 'self', pid: process.pid }]);
  assert.equal(result[0].state, 'active');
  if (process.platform === 'win32') {
    const mismatch = await probeProcesses([{ key: 'reused', pid: process.pid, procStart: '1111111111111111' }]);
    assert.equal(mismatch[0].state, 'inactive');
  }
});

test('self deletion always needs active confirmation even if the catalog scan reports inactive', async t => {
  const f = await fixture(t); await f.session(A, 'Current');
  const options = { ...f.options, ...await f.current(), currentSessionId: A };
  const preview = await previewCurrentSessionDelete(options);
  assert.equal(preview.currentSession, true);
  assert.equal(preview.session.activity.state, 'inactive');
  assert.equal(preview.requiresConfirmation, 'active');
  assert.match(preview.confirmationFingerprint, /^[a-f0-9]{64}$/);
  await assert.rejects(executeCurrentSessionDelete({ ...options, expect: preview.confirmationFingerprint }), { code: 'active_confirmation_required' });
  await assert.rejects(executeCurrentSessionDelete({ ...options, expect: preview.confirmationFingerprint, allowUnknown: true }), { code: 'active_confirmation_required' });
  await assert.rejects(executeCurrentSessionDelete({ ...options, allowActive: true }), { code: 'preview_required' });
  assert.equal(await f.exists(`projects/demo/${A}.jsonl`), true);
});

test('self deletion refreshes transcript and history after confirmation, preserving other Sessions', async t => {
  const f = await fixture(t); await f.session(A, 'Current'); await f.session(B, 'Newer same-project Session');
  const options = { ...f.options, ...await f.current(), currentSessionId: A, allowActive: true };
  const preview = await previewCurrentSessionDelete(options);
  await fs.appendFile(path.join(f.root, `projects/demo/${A}.jsonl`), JSON.stringify({ type: 'user', message: { content: '确认删除本 Session' } }) + '\n');
  const keep = JSON.stringify({ sessionId: B, display: 'Keep this row' }) + '\n';
  await f.put('history.jsonl', JSON.stringify({ sessionId: A, display: '确认删除本 Session' }) + '\n' + keep);
  const refreshed = await previewCurrentSessionDelete(options);
  assert.equal(refreshed.confirmationFingerprint, preview.confirmationFingerprint);
  assert.notEqual(refreshed.fingerprint, preview.fingerprint);
  const result = await executeCurrentSessionDelete({ ...options, expect: preview.confirmationFingerprint });
  assert.equal(result.status, 'deleted'); assert.equal(result.id, A);
  assert.equal(result.runtimeStillActive, true);
  assert.equal(await f.exists(`projects/demo/${A}.jsonl`), false);
  assert.equal(await f.exists(`projects/demo/${B}.jsonl`), true);
  assert.equal(await fs.readFile(path.join(f.root, 'history.jsonl'), 'utf8'), keep);
});

test('self deletion refuses missing, unresolved, partial or conflicting targets', async t => {
  const f = await fixture(t); await f.session(A, 'Current');
  for (const currentSessionId of [undefined, '', '${CLAUDE_SESSION_ID}', A.slice(0, 8), '../projects', 'current']) {
    await assert.rejects(previewCurrentSessionDelete({ ...f.options, currentSessionId }), { code: 'current_session_unavailable' });
  }
  for (const other of [{ id: B }, { query: 'Current' }]) {
    await assert.rejects(previewCurrentSessionDelete({ ...f.options, currentSessionId: A, ...other }), { code: 'invalid_options' });
  }
  assert.equal(await f.exists(`projects/demo/${A}.jsonl`), true);
});

test('self confirmation binds target, root and scope and cannot use a normal file fingerprint', async t => {
  const f = await fixture(t); await f.session(A, 'Current'); await f.session(B, 'Other');
  const otherRoot = await fixture(t); await otherRoot.session(A, 'Same UUID elsewhere');
  const options = { ...f.options, ...await f.current(), currentSessionId: A, allowActive: true };
  await otherRoot.current();
  const preview = await previewCurrentSessionDelete(options);
  for (const change of [
    { root: otherRoot.root },
    { scope: 'current', project: path.join(f.root, 'source/demo') },
    { expect: preview.fingerprint },
  ]) {
    await assert.rejects(executeCurrentSessionDelete({ ...options, expect: preview.confirmationFingerprint, ...change }), { code: 'stale_preview' });
  }
  await assert.rejects(executeCurrentSessionDelete({ ...options, currentSessionId: B, expect: preview.confirmationFingerprint }), { code: 'current_session_mismatch' });
  assert.equal(await f.exists(`projects/demo/${A}.jsonl`), true);
  assert.equal(await f.exists(`projects/demo/${B}.jsonl`), true);
  assert.equal(await otherRoot.exists(`projects/demo/${A}.jsonl`), true);
});

test('self deletion respects current project and cross-project restrictions', async t => {
  const f = await fixture(t); await f.session(A, 'Current', 'first'); await f.session(B, 'Other', 'second');
  const options = { root: f.root, project: path.join(f.root, 'source/first'), ...await f.current(B), currentSessionId: B, probe: inactive };
  assert.equal((await previewCurrentSessionDelete(options)).status, 'not_found');
  await f.session(A, 'Shared ID', 'second');
  await assert.rejects(previewCurrentSessionDelete({ ...options, ...await f.current(A), currentSessionId: A }), { code: 'cross_project_session' });
  assert.equal(await f.exists(`projects/second/${B}.jsonl`), true);
});

test('missing explicit current ID cannot resolve to another Session with that ID as its title', async t => {
  const f = await fixture(t); await f.session(B, A);
  assert.equal((await previewCurrentSessionDelete({ ...f.options, ...await f.current(), currentSessionId: A })).status, 'not_found');
  assert.equal((await previewDelete({ ...f.options, id: A })).status, 'not_found');
  assert.equal(await f.exists(`projects/demo/${B}.jsonl`), true);
});

test('self confirmation is invalidated by changed process identity', async t => {
  const f = await fixture(t); await f.session(A, 'Current');
  const record = { sessionId: A, pid: 9, procStart: '1234567890123456' };
  await f.put('sessions/9.json', record);
  const options = { ...f.options, ...await f.current(), currentSessionId: A, probe: active, allowActive: true };
  const preview = await previewCurrentSessionDelete(options);
  await f.put('sessions/9.json', { ...record, procStart: '2234567890123456' });
  await assert.rejects(executeCurrentSessionDelete({ ...options, expect: preview.confirmationFingerprint }), { code: 'stale_preview' });
  assert.equal(await f.exists(`projects/demo/${A}.jsonl`), true);
});

test('self deletion preserves unknown-state confirmation requirement', async t => {
  const f = await fixture(t); await f.session(A, 'Current');
  await f.put('sessions/9.json', { sessionId: A, pid: 9 });
  const options = { ...f.options, ...await f.current(), currentSessionId: A, probe: async () => { throw new Error('Access denied'); }, allowActive: true };
  const preview = await previewCurrentSessionDelete(options);
  assert.equal(preview.session.activity.state, 'unknown');
  await assert.rejects(executeCurrentSessionDelete({ ...options, expect: preview.confirmationFingerprint }), { code: 'unknown_confirmation_required' });
  assert.equal((await executeCurrentSessionDelete({ ...options, expect: preview.confirmationFingerprint, allowUnknown: true })).status, 'deleted');
});

test('self deletion still rejects writes between its fresh preview and execution without retrying', async t => {
  const f = await fixture(t); await f.session(A, 'Current');
  const options = { ...f.options, ...await f.current(), currentSessionId: A, allowActive: true };
  const preview = await previewCurrentSessionDelete(options);
  let probes = 0;
  const probe = async records => {
    if (++probes === 2) await fs.appendFile(path.join(f.root, `projects/demo/${A}.jsonl`), JSON.stringify({ type: 'assistant' }) + '\n');
    return inactive(records);
  };
  await assert.rejects(executeCurrentSessionDelete({ ...options, expect: preview.confirmationFingerprint, probe }), { code: 'stale_preview' });
  assert.equal(probes, 2);
  assert.equal(await f.exists(`projects/demo/${A}.jsonl`), true);
});

test('CLI self deletion resolves fresh runtime identity and rejects the old ID after resume A then B', async t => {
  const f = await fixture(t); await f.session(A, 'Current'); await f.session(B, 'Other');
  if (!['win32', 'linux'].includes(process.platform)) { t.skip('Verified self deletion supports Windows and Linux'); return; }
  let procStart;
  if (process.platform === 'win32') {
    const result = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().ToFileTimeUtc().ToString()`], { encoding: 'utf8' });
    assert.equal(result.status, 0); procStart = result.stdout.trim();
  } else {
    const stat = await fs.readFile(`/proc/${process.pid}/stat`, 'utf8');
    procStart = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
  }
  const registration = id => f.put(`sessions/${process.pid}.json`, { pid: process.pid, sessionId: id, procStart });
  await registration(A);
  const call = (args, id = A) => {
    const result = spawnSync(process.execPath, [cli, '--harness', 'claude', ...args, '--root', f.root], {
      cwd: path.join(f.root, 'source/demo'), encoding: 'utf8', env: {
        ...process.env, CLAUDE_SESSION_ID: A, CLAUDE_CODE_SESSION_ID: id, CLAUDE_PID: String(process.pid),
      },
    });
    return { code: result.status, result: JSON.parse(result.stdout) };
  };
  assert.equal(call(['delete', '--current-session', '${CLAUDE_SESSION_ID}']).result.code, 'current_session_unavailable');
  assert.equal(call(['delete', '--current-session', A, '--id', B]).result.code, 'invalid_options');
  assert.equal(call(['list', '--current-session', A]).result.code, 'invalid_options');
  const preview = call(['delete', '--current-session', 'auto']);
  assert.equal(preview.code, 0); assert.equal(preview.result.session.id, A);
  assert.equal(preview.result.scope, 'current');
  assert.equal(await f.exists(`projects/demo/${A}.jsonl`), true);
  const execution = ['delete', '--current-session', A, '--expect', preview.result.confirmationFingerprint, '--execute'];
  assert.equal(call(execution).result.code, 'active_confirmation_required');
  await registration(B);
  assert.equal(call([...execution, '--allow-active'], B).result.code, 'current_session_mismatch');
  assert.equal(call([...execution, '--allow-active'], A).result.code, 'current_session_mismatch');
  const afterResume = call(['delete', '--current-session', 'auto'], B);
  assert.equal(afterResume.result.session.id, B);
  const done = call(['delete', '--current-session', B, '--expect', afterResume.result.confirmationFingerprint, '--execute', '--allow-active'], B);
  assert.equal(done.code, 0); assert.equal(done.result.status, 'deleted');
  assert.equal(await f.exists(`projects/demo/${B}.jsonl`), false);
  assert.equal(await f.exists(`projects/demo/${A}.jsonl`), true);
});

test('self deletion fails closed without fresh runtime context even if an old UUID and confirmation are supplied', async t => {
  const f = await fixture(t); await f.session(A, 'Old');
  for (const runtimeEnv of [{}, { CLAUDE_SESSION_ID: A }, { CLAUDE_CODE_SESSION_ID: A },
    { CLAUDE_CODE_SESSION_ID: A, CLAUDE_PID: '../9001' }]) {
    const options = { ...f.options, currentSessionId: A, runtimeEnv };
    await assert.rejects(previewCurrentSessionDelete(options), { code: 'current_session_unverified' });
    await assert.rejects(executeCurrentSessionDelete({ ...options, expect: 'a'.repeat(64), allowActive: true }), { code: 'current_session_unverified' });
  }
  assert.equal(await f.exists(`projects/demo/${A}.jsonl`), true);
});

test('runtime registry and process identity must independently verify the current shell ID', async t => {
  const f = await fixture(t); await f.session(A, 'Current');
  const options = { ...f.options, ...await f.current() };
  await fs.unlink(path.join(f.root, 'sessions/9001.json'));
  await assert.rejects(resolveCurrentRuntime(options), { code: 'current_session_unverified' });
  for (const record of [
    { pid: 9002, sessionId: A, procStart: '123' }, { pid: 9001, sessionId: A },
    { pid: 9001, sessionId: 'bad', procStart: '123' },
  ]) {
    await f.put('sessions/9001.json', record);
    await assert.rejects(resolveCurrentRuntime(options), { code: 'current_session_unverified' });
  }
  await f.current();
  await assert.rejects(resolveCurrentRuntime({ ...options, probeCurrent: async () => false }), { code: 'current_session_unverified' });
  await assert.rejects(resolveCurrentRuntime({ ...options, probeCurrent: async () => { throw new Error('Denied'); } }), { code: 'current_session_unverified' });
  await f.current(B);
  await assert.rejects(resolveCurrentRuntime(options), { code: 'current_session_mismatch' });
});

test('resume invalidates old confirmation and correct self deletion preserves A byte-for-byte', async t => {
  const f = await fixture(t); await f.session(A, 'A'); await f.session(B, 'B');
  const aBytes = await fs.readFile(path.join(f.root, `projects/demo/${A}.jsonl`));
  const base = { ...f.options, currentSessionId: 'auto', allowActive: true };
  const before = await previewCurrentSessionDelete({ ...base, ...await f.current(A) });
  const runtimeB = await f.current(B);
  await assert.rejects(executeCurrentSessionDelete({ ...base, ...runtimeB, expect: before.confirmationFingerprint }), { code: 'stale_preview' });
  await assert.rejects(previewCurrentSessionDelete({ ...base, ...runtimeB, currentSessionId: A }), { code: 'current_session_mismatch' });
  const after = await previewCurrentSessionDelete({ ...base, ...runtimeB });
  assert.equal(after.session.id, B);
  assert.equal((await executeCurrentSessionDelete({ ...base, ...runtimeB, expect: after.confirmationFingerprint })).status, 'deleted');
  assert.deepEqual(await fs.readFile(path.join(f.root, `projects/demo/${A}.jsonl`)), aBytes);
});

test('switching the runtime during the final scan blocks all data mutations', async t => {
  const f = await fixture(t); await f.session(A, 'A'); await f.session(B, 'B');
  const options = { ...f.options, ...await f.current(), currentSessionId: A, allowActive: true };
  const preview = await previewCurrentSessionDelete(options);
  let probes = 0;
  const probe = async records => {
    if (++probes === 2) await f.current(B);
    return inactive(records);
  };
  await assert.rejects(executeCurrentSessionDelete({ ...options, probe, expect: preview.confirmationFingerprint }), { code: 'current_session_mismatch' });
  assert.equal(await f.exists(`projects/demo/${A}.jsonl`), true);
  assert.equal(await f.exists(`projects/demo/${B}.jsonl`), true);
});
