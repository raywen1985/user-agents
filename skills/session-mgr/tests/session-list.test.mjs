import assert from 'node:assert/strict';
import test from 'node:test';
import { collectSessionList, formatSessionListPages } from '../scripts/session-list.mjs';

function session(index, overrides = {}) {
  return { id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, harness: 'claude',
    name: `会话 ${index}`, nameSource: 'custom-title-file', projects: [`/projects/work-${index}`],
    lastActiveAt: new Date(1700000000000 + index * 60000).toISOString(),
    activity: { state: 'inactive' }, ...overrides };
}

test('all session rows, full IDs and paths survive automatic byte-bounded pagination in recency order', () => {
  for (const count of [0, 87, 237]) {
    const sessions = Array.from({ length: count }, (_, index) => session(index));
    const pages = formatSessionListPages({ harness: 'claude', sessions, complete: true, warnings: [] }, { maxBytes: 3000 });
    const all = pages.join('\n');
    assert.deepEqual([...all.matchAll(/ID：([^\n]+)/g)].map(match => match[1]), sessions.toReversed().map(item => item.id));
    for (const page of pages) assert.ok(Buffer.byteLength(`[Gateway | - | - | -]\n${page}`, 'utf8') <= 3000);
    for (const page of pages) assert.ok([...page.matchAll(/^ID：/gm)].length <= 25);
    for (const item of sessions) assert.ok(all.includes(item.projects[0]));
    assert.match(all, new RegExp(`共 ${count} 条`));
    if (count === 0) assert.match(all, /没有发现会话/);
  }
});

test('readable default batches never contain more than 25 sessions even below the byte limit', () => {
  const pages = formatSessionListPages({ harness: 'codex', complete: true, sessions: Array.from({ length: 51 }, (_, index) => session(index)) });
  assert.deepEqual(pages.map(page => [...page.matchAll(/^ID：/gm)].length), [25, 25, 1]);
});

test('known multiple projects and owner states are displayed without guessing running or resume authority', () => {
  const pages = formatSessionListPages({ harness: 'all', complete: true, sessions: [
    session(1, { projects: ['/projects/a', '/projects/b'], activity: { state: 'active' } }),
    session(2, { harness: 'codex', activity: { state: 'unknown' }, nameSource: 'first-prompt', archived: true }),
  ] });
  assert.match(pages[0], /记录涉及多个路径.*\/projects\/a；\/projects\/b/);
  assert.match(pages[0], /进程占用（可能空闲）/);
  assert.match(pages[0], /占用状态未知/);
  assert.match(pages[0], /摘要\/首条输入代名/);
  assert.match(pages[0], /已归档/);
  assert.doesNotMatch(pages[0], /归属未知|可恢复|运行中/);
});

test('an unusually long project list continues across pages without losing text', () => {
  const item = session(1, { projects: Array.from({ length: 200 }, (_, index) => `/very-long-project/工程-${index}`) });
  const pages = formatSessionListPages({ harness: 'claude', complete: true, sessions: [item] }, { maxBytes: 2048 });
  assert.ok(pages.length > 1);
  const bodies = pages.map(page => page.split('\n\n').slice(1).join('\n\n')).join('');
  for (const project of item.projects) assert.ok(bodies.includes(project));
  for (const page of pages) assert.ok(Buffer.byteLength(page, 'utf8') <= 2048);
});

test('one failed harness preserves other records and reports partial instead of empty/full success', async () => {
  const calls = [];
  const result = await collectSessionList({ harness: 'all', claudeRoot: '/claude-root', codexRoot: '/codex-root',
    readSessions: async options => {
      calls.push(options);
      if (options.harness === 'codex') throw new Error('unavailable');
      return { sessions: [session(1)], complete: true, warnings: [] };
    } });
  assert.equal(result.total, 1);
  assert.equal(result.complete, false);
  assert.equal(calls[0].scope, 'all');
  assert.equal(calls.find(item => item.harness === 'codex').root, '/codex-root');
  assert.match(formatSessionListPages(result)[0], /扫描不完整.*仅已读到/);
  assert.match(formatSessionListPages(result)[0], /Codex 读取失败/);
  const failed = await collectSessionList({ harness: 'claude', readSessions: async () => { throw new Error('bad'); } });
  assert.match(formatSessionListPages(failed)[0], /不能判定没有会话/);
});

test('Claude-only listing never resolves Codex; a failed executable lookup does not erase Claude records', async () => {
  let resolutions = 0;
  const options = { resolveCodexBin: async () => { resolutions++; throw new Error('missing'); },
    readSessions: async () => ({ sessions: [session(1)], complete: true }) };
  assert.equal((await collectSessionList({ ...options, harness: 'claude' })).complete, true);
  assert.equal(resolutions, 0);
  const all = await collectSessionList({ ...options, harness: 'all' });
  assert.equal(resolutions, 1);
  assert.equal(all.total, 1);
  assert.equal(all.complete, false);
});
