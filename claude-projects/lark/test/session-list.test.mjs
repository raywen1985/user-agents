import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Store } from '../src/store.mjs';
import { parseSessionListQuery, createSessionListHandler } from '../src/session-list.mjs';
import { resolveIntent } from '../src/resolver.mjs';
import { createInternalSkillRegistry } from '../src/internal-skills.mjs';

test('pure global native-list phrases are deterministic and mixed/specific requests are not swallowed', () => {
  for (const text of ['列出所有claudecode会话', '列出所有 Claude Code 会话', '查看 Claude Code 会话列表']) {
    assert.equal(parseSessionListQuery(text)?.overviewExecutor, 'claude');
  }
  assert.equal(parseSessionListQuery('列出所有 Codex Session')?.overviewExecutor, 'codex');
  assert.equal(parseSessionListQuery('列出所有会话')?.overviewExecutor, null);
  for (const text of ['列出所有claudecode会话然后删除', '列出项目 A 的 Claude 会话', '查看会话 X',
    '列出正在工作的会话', 'codex 会话名 列出所有claudecode会话']) assert.equal(parseSessionListQuery(text), null);
});

test('native list resolver retains harness and rejects mixed or scoped operations', () => {
  const registry = createInternalSkillRegistry();
  const base = { action: 'internal_skill', skill_name: 'list_agent_sessions', overview_scope: 'all', overview_executor: 'claude' };
  assert.deepEqual(resolveIntent(base, {}, {}, {}, registry), {
    type: 'internal_skill', skillName: 'list_agent_sessions', overviewExecutor: 'claude',
  });
  assert.equal(resolveIntent({ ...base, content: 'delete' }, {}, {}, {}, registry).type, 'reply');
  assert.equal(resolveIntent({ ...base, project_query: 'work' }, {}, {}, {}, registry).type, 'reply');
  assert.equal(resolveIntent({ action: 'list', executor: 'codex' }, {}, {}, {}, registry).overviewExecutor, 'codex');
});

test('all pages persist before delivery and restart/retry uses the first snapshot without duplicates', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-list-'));
  const database = path.join(dir, 'gateway.sqlite');
  let store = new Store(database), calls = 0;
  try {
    const handler = createSessionListHandler({ store, query: async () => { calls++; return ['one', 'two', 'three']; },
      flushOutbox: async () => {
        assert.equal(store.db.prepare('SELECT count(*) AS count FROM outbox').get().count, 3);
        store.completeOutboxDelivery(store.nextOutbox().id, 'remote-one');
        throw new Error('network unavailable');
      } });
    await assert.rejects(handler('claude', 'message-1'), /network unavailable/);
    store.close(); store = new Store(database);
    const delivered = [];
    await createSessionListHandler({ store, query: async () => { calls++; return ['changed']; },
      flushOutbox: async () => { let row; while ((row = store.nextOutbox())) { delivered.push(row.text); store.completeOutboxDelivery(row.id, `remote-${row.id}`); } },
    })('claude', 'message-1');
    assert.equal(calls, 1);
    assert.deepEqual(delivered, ['[Gateway | - | - | -]\ntwo', '[Gateway | - | - | -]\nthree']);
    assert.equal(store.db.prepare('SELECT count(*) AS count FROM outbox').get().count, 3);
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
