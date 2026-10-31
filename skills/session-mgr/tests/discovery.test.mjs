import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { listSessions } from '../scripts/claude-reader.mjs';
import { collectClaudeHistory, readClaudeHistorySnapshot, revalidateClaudeHistoryCandidate } from '../scripts/discovery/claude-session-history.mjs';
import { buildSessionCatalog, collectClaudeLiveOwners, collectCodexHistory } from '../scripts/discovery/session-catalog.mjs';
import { collectClaudeCandidates } from '../scripts/discovery/active-agent-sessions.mjs';
import { inspectManagedWorkspace, listWorkingSessions } from '../scripts/queries.mjs';

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const cli = fileURLToPath(new URL('../scripts/session-manager.mjs', import.meta.url));
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sessionmgr-discovery-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'work'), other = path.join(root, 'other');
  await fs.mkdir(project); await fs.mkdir(other);
  const put = async (relative, value) => {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const transcript = (id, cwd, title, content = 'SECRET_BODY') => put(`projects/opaque/${id}.jsonl`, [
    { type: 'user', sessionId: id, cwd, timestamp: '2026-10-29T00:00:00Z', message: { content } },
    { type: 'custom-title', sessionId: id, customTitle: title, timestamp: '2026-10-30T00:00:00Z' },
  ].map(item => JSON.stringify(item)).join('\n'));
  return { root, project, other, put, transcript };
}

test('shared reader finds transcript titles and late renames, while remote metadata omits prompt and summary', async t => {
  const f = await fixture(t);
  await f.transcript(A, f.project, 'Original');
  await fs.appendFile(path.join(f.root, `projects/opaque/${A}.jsonl`), '\n' + JSON.stringify({
    type: 'custom-title', sessionId: A, customTitle: 'Renamed', timestamp: '2026-10-30T01:00:00Z',
  }));
  await f.put(`projects/opaque/${B}.jsonl`, JSON.stringify({ type: 'user', sessionId: B, cwd: f.project, message: { content: 'SECRET_PROMPT' } }));
  await f.put('projects/opaque/sessions-index.json', { entries: [{ sessionId: B, summary: 'SECRET_SUMMARY' }] });
  const local = await listSessions({ root: f.root, scope: 'all' });
  const remote = await collectClaudeHistory({ claudeRoot: f.root });
  assert.equal(local.sessions.find(s => s.id === A).name, 'Renamed');
  assert.equal(remote.records.find(s => s.nativeId === A).name, 'Renamed');
  assert.equal(remote.records.find(s => s.nativeId === B).name, null);
  assert.doesNotMatch(JSON.stringify(remote), /SECRET_/);
  const catalog = await buildSessionCatalog({ claudeRoot: f.root, executor: 'claude' });
  assert.equal(catalog.complete, true);
  assert.equal(catalog.candidates.length, 2);
  assert.equal(catalog.candidates.find(s => s.nativeId === B).name, '未命名 Session');
});

test('index-only records lack authority; later cwd observations preserve the unique original envelope', async t => {
  const f = await fixture(t);
  await f.transcript(A, f.project, 'Conflict');
  await fs.appendFile(path.join(f.root, `projects/opaque/${A}.jsonl`), '\n' + JSON.stringify({ sessionId: A, cwd: f.other }));
  await f.put('projects/opaque/sessions-index.json', { originalPath: f.project, entries: [{ sessionId: B, customTitle: 'Index only' }] });
  const result = await collectClaudeHistory({ claudeRoot: f.root });
  assert.equal(result.complete, true);
  assert.equal(result.records.length, 2);
  const native = result.records.find(item => item.nativeId === A), indexOnly = result.records.find(item => item.nativeId === B);
  assert.equal(native.projectVerified, true); assert.equal(native.projectPath, f.project);
  assert.deepEqual(new Set(native.observedProjects), new Set([f.project, f.other]));
  assert.deepEqual(indexOnly.observedProjects, [f.project]);
  assert.equal(indexOnly.projectVerified, false); assert.equal(indexOnly.sourcePath, null); assert.equal(indexOnly.authority, null);
  // Two actual transcripts are conflicting ownership evidence, unlike a later cd.
  await f.put(`projects/duplicate/${A}.jsonl`, JSON.stringify({ type: 'user', sessionId: A, cwd: f.other }));
  const conflict = (await collectClaudeHistory({ claudeRoot: f.root })).records.find(item => item.nativeId === A);
  assert.equal(conflict.projectVerified, false); assert.equal(conflict.sourcePath, null);
  assert.deepEqual(await revalidateClaudeHistoryCandidate(native), { ok: false, reason: 'identity_conflict' });
});

test('excluded projects and linked native evidence cannot authorize a continuation', async t => {
  const f = await fixture(t);
  await f.transcript(A, f.project, 'Safe title');
  const excluded = await collectClaudeHistory({ claudeRoot: f.root, config: { projects: [], excludedRoots: [f.project] } });
  assert.equal(excluded.records.length, 0);
  const normal = await collectClaudeHistory({ claudeRoot: f.root });
  const candidate = normal.records[0];
  assert.equal((await revalidateClaudeHistoryCandidate(candidate)).ok, true);
  await f.transcript(A, f.other, 'Safe title');
  assert.equal((await revalidateClaudeHistoryCandidate(candidate)).ok, false);
  await fs.symlink(f.other, path.join(f.root, 'projects', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await collectClaudeHistory({ claudeRoot: f.root })).complete, false);
});

test('scan limits and worker timeout report incomplete, never an authoritative empty result', async t => {
  const f = await fixture(t); await f.transcript(A, f.project, 'Name');
  assert.equal((await collectClaudeHistory({ claudeRoot: f.root, maximumEntries: 0 })).complete, false);
  let terminated = false;
  class HungWorker extends EventEmitter { terminate() { terminated = true; } }
  const result = await readClaudeHistorySnapshot({ WorkerImpl: HungWorker, timeoutMs: 10 });
  assert.equal(result.complete, false); assert.equal(terminated, true);
});

test('working activity excludes idle Claude owners but resume ownership still includes them', async t => {
  const f = await fixture(t);
  for (const [id, pid, status] of [[A, 10, 'idle'], [B, 11, 'running']]) {
    await f.put(`sessions/${pid}.json`, { sessionId: id, pid, procStart: '1234567890123456', cwd: f.project, status, name: status });
  }
  const candidates = await collectClaudeCandidates({ claudeRoot: f.root });
  assert.deepEqual(candidates.records.map(s => s.nativeId), [B]);
  const probe = async ({ processes }) => ({ processes: new Map(processes.map(item => [item.id, { state: 'live' }])) });
  assert.deepEqual(await collectClaudeLiveOwners({ claudeRoot: f.root, probe }), new Set([A, B]));
  await assert.rejects(collectClaudeLiveOwners({ claudeRoot: f.root, probe: async () => ({ processes: new Map() }) }), /incomplete/);
});

test('overview CLI scopes to the caller project and rejects deletion flags', async t => {
  const f = await fixture(t);
  await f.transcript(A, f.project, 'Alpha'); await f.transcript(B, f.other, 'Beta');
  const call = extra => spawnSync(process.execPath, [cli, 'overview', '--harness', 'claude', '--root', f.root, ...extra], {
    cwd: f.project, encoding: 'utf8', windowsHide: true,
  });
  const current = call([]);
  assert.equal(current.status, 0, current.stderr || current.stdout);
  assert.deepEqual(JSON.parse(current.stdout).sessions.map(s => s.id), [A]);
  const all = JSON.parse(call(['--scope', 'all']).stdout);
  assert.equal(all.total, 2); assert.equal(all.projects.length, 2); assert.equal(all.complete, true);
  assert.equal(JSON.parse(call(['--scope', 'all', '--query', 'Beta']).stdout).sessions[0].id, B);
  assert.equal(call(['--execute']).status, 1);
});

test('working query preserves harness identities, scope and recent order', async t => {
  const f = await fixture(t);
  const records = [
    { agent: 'claude', nativeId: A, name: 'old', cwd: f.project, updatedAt: 1000, status: 'running' },
    { agent: 'codex', nativeId: A, name: 'new', cwd: f.project, updatedAt: 2000, status: 'queued' },
    { agent: 'claude', nativeId: B, name: 'other', cwd: f.other, updatedAt: 3000, status: 'running' },
  ];
  const collectActive = async () => ({ records, completeness: { gateway: true, claude: true, codex: false }, warnings: ['partial'], additionalHidden: 1 });
  const all = await listWorkingSessions({ harness: 'all', project: f.project, collectActive });
  assert.deepEqual(all.sessions.map(s => s.harness), ['codex', 'claude']);
  assert.equal(all.complete, false); assert.equal(all.additionalHidden, 1);
  const claude = await listWorkingSessions({ harness: 'claude', scope: 'all', collectActive });
  assert.deepEqual(claude.sessions.map(s => s.id), [B, A]);
});

test('overview reports incomplete history and unknown activity without inventing resumability', async t => {
  const f = await fixture(t);
  const result = await inspectManagedWorkspace({ harness: 'claude', scope: 'all', collectSnapshot: async () => ({
    sessions: [{ executor: 'claude', nativeId: A, name: 'Unknown', projectPath: f.project, activity: 'unknown', resumeCapability: 'unavailable' }],
    historyComplete: false, activity: { completeness: { gateway: true, claude: false } }, warnings: ['incomplete'],
  }) });
  assert.equal(result.complete, false); assert.equal(result.sessions[0].resumeCapability, 'unavailable');
});

test('current overview counts only the requested project while retaining observed paths on the session', async t => {
  const f = await fixture(t);
  const collectSnapshot = async () => ({ sessions: [
    { executor: 'claude', nativeId: A, name: 'Visited', displayProjects: [f.project, f.other], activity: 'idle', resumeCapability: 'unavailable' },
    { executor: 'claude', nativeId: B, name: 'Other', displayProjects: [f.other], activity: 'idle', resumeCapability: 'resumable' },
  ], historyComplete: true, activity: { completeness: { gateway: true, claude: true } }, warnings: [] });
  const current = await inspectManagedWorkspace({ harness: 'claude', project: f.project, collectSnapshot });
  assert.deepEqual(current.projects, [{ path: f.project, name: path.basename(f.project), total: 1 }]);
  assert.deepEqual(current.sessions[0].projects, [f.project, f.other]);
  assert.equal((await inspectManagedWorkspace({ harness: 'claude', scope: 'all', collectSnapshot })).projects.length, 2);
});

test('Codex overview excludes internal threads and includes unnamed/legacy/archived user sessions', async t => {
  const f = await fixture(t), state = new DatabaseSync(path.join(f.root, 'state_5.sqlite'));
  await fs.mkdir(path.join(f.root, 'thread-writer-locks'));
  const C = '33333333-3333-4333-8333-333333333333', D = '44444444-4444-4444-8444-444444444444';
  state.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, cwd TEXT, updated_at_ms INTEGER, thread_source TEXT, source TEXT, archived INTEGER)');
  const insert = state.prepare('INSERT INTO threads VALUES (?, ?, ?, 1000, ?, ?, ?)');
  insert.run(A, 'User', f.project, 'user', 'cli', 0);
  insert.run(B, null, f.project, null, 'vscode', 1);
  insert.run(C, 'Guardian review', f.project, 'guardian_review', 'cli', 0);
  insert.run(D, 'Subagent', f.project, 'subagent', 'cli', 0);
  state.close();
  const history = new DatabaseSync(path.join(f.root, 'thread_history_1.sqlite'));
  history.exec('CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, status TEXT, started_at INTEGER)'); history.close();
  // The optional name index deliberately omits the archived, unnamed user thread.
  await f.put('session_index.jsonl', [A, C, D].map(id => JSON.stringify({ id, thread_name: id === A ? 'User' : 'Internal', updated_at: '2026-10-30T00:00:00Z' })).join('\n'));
  const catalog = await collectCodexHistory({ codexRoot: f.root });
  assert.equal(catalog.complete, true); assert.deepEqual(catalog.records.map(item => item.nativeId).sort(), [A, B]);
  const overview = await inspectManagedWorkspace({ harness: 'codex', root: f.root, scope: 'all' });
  assert.equal(overview.complete, true, JSON.stringify({ historyComplete: overview.historyComplete, warnings: overview.warnings }));
  assert.deepEqual(overview.sessions.map(item => item.id).sort(), [A, B]);
  await fs.unlink(path.join(f.root, 'session_index.jsonl'));
  assert.equal((await collectCodexHistory({ codexRoot: f.root })).records.length, 2);
});

test('existing list entry stays usable without installing the optional discovery modules', async t => {
  const f = await fixture(t);
  const scripts = path.join(f.root, 'installed');
  await fs.mkdir(scripts);
  for (const file of ['session-manager.mjs', 'harnesses.mjs', 'session-store.mjs', 'claude-reader.mjs',
    'current-session.mjs', 'current-runtime.mjs', 'codex-store.mjs', 'codex-rpc.mjs', 'codex-executable.mjs', 'probe-processes.ps1']) {
    await fs.copyFile(fileURLToPath(new URL(`../scripts/${file}`, import.meta.url)), path.join(scripts, file));
  }
  const result = spawnSync(process.execPath, [path.join(scripts, 'session-manager.mjs'), 'list',
    '--harness', 'claude', '--scope', 'all', '--root', path.join(f.root, 'empty')], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).total, 0);
});
