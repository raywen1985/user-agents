import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { canAcceptUserMessage, inboundUnavailableText } from '../src/lark.mjs';
import { logLookupFailure, retrySnapshot } from '../src/lookup-observation.mjs';
import { parseSpeechPermission, createVoiceReadiness } from '../src/voice-readiness.mjs';
import { VoiceTranscriber } from '../src/voice.mjs';
import { readNotificationBinding, pruneNotificationBindings, NOTIFICATION_TTL_MS } from '../src/notification-replies.mjs';
import { logger } from '../src/logger.mjs';

test('authorized unsupported media and disabled audio receive feedback; strangers and bot events remain rejected', () => {
  const message = { chat_type: 'p2p', sender_type: 'user', sender_id: 'ou_owner', message_id: 'om_media', content: '' };
  for (const message_type of ['image', 'file', 'video', 'sticker']) {
    const value = { ...message, message_type };
    assert.equal(canAcceptUserMessage(value, ['ou_owner']), true);
    assert.match(inboundUnavailableText(value, true), /仅支持纯文本和语音/);
    assert.equal(canAcceptUserMessage({ ...value, sender_type: 'app' }, ['ou_owner']), false);
    assert.equal(canAcceptUserMessage({ ...value, sender_id: 'ou_stranger' }, ['ou_owner']), false);
  }
  assert.match(inboundUnavailableText({ ...message, message_type: 'audio' }, false), /未启用/);
});

test('incomplete observations retry only once and do not retry busy or archived targets', async () => {
  for (const initial of [{ complete: false }, { ok: false, reason: 'snapshot_incomplete' }]) {
    let calls = 0, waits = 0;
    const result = await retrySnapshot(async () => ++calls === 1 ? initial : { ok: true, complete: true }, { sleep: async () => { waits++; } });
    assert.equal(result.ok, true); assert.equal(calls, 2); assert.equal(waits, 1);
  }
  let calls = 0;
  await retrySnapshot(async () => { calls++; return { complete: false }; }, { sleep: async () => {} });
  assert.equal(calls, 2);
  for (const reason of ['busy', 'archived', 'native_missing']) {
    calls = 0;
    await retrySnapshot(async () => { calls++; return { ok: false, reason }; }, { sleep: async () => { throw new Error('unexpected wait'); } });
    assert.equal(calls, 1);
  }
});

test('diagnostics keep only safe identifiers and fixed reasons', () => {
  let record;
  logLookupFailure({ messageId: 'om_one\nTOKEN', executor: 'codex', reason: 'secret task body' }, { warn: (_, value) => { record = value; } });
  assert.deepEqual(record, { messageId: 'om_oneTOKEN', executor: 'codex', reason: 'lookup_failed' });
});

test('test logger and inherited child logger write only to the isolated directory', () => {
  assert.ok(process.env.NODE_TEST_CONTEXT);
  assert.equal(path.dirname(logger.path), process.env.LARK_GATEWAY_LOG_DIR);
  assert.notEqual(path.dirname(logger.path), path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'lark-claude'));
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    "import {logger} from './src/logger.mjs'; console.log(JSON.stringify({path:logger.path}));"],
  { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, NODE_TEST_CONTEXT: '' }, encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).path, logger.path);
});

function permission(scope_type = 'tenant', grant_status = 1) {
  return { code: 0, stdout: JSON.stringify({ ok: true, identity: 'bot', data: { scopes: [
    { scope_name: 'speech_to_text:speech', grant_status, scope_type },
  ] } }) };
}
test('speech readiness checks tenant permissions, never mistakes user scopes for bot grants, and caches reads', async () => {
  assert.equal(parseSpeechPermission(permission()), 'granted');
  assert.equal(parseSpeechPermission(permission('user')), 'missing');
  assert.equal(parseSpeechPermission(permission('tenant', 2)), 'missing');
  assert.equal(parseSpeechPermission({ code: 0, stdout: '{"tokenType":"user","userScopes":[]}' }), 'unknown');
  let calls = 0;
  const ready = createVoiceReadiness({ executable: 'fake', run: async (_, args) => {
    calls++; assert.deepEqual(args, ['api', 'GET', '/open-apis/application/v6/scopes', '--as', 'bot']); return permission();
  } });
  await Promise.all([ready.check(), ready.check()]); await ready.check();
  assert.equal(calls, 1); assert.equal(ready.snapshot().recognition, 'untested');
  ready.record('VOICE_RATE_LIMITED', 99991400);
  assert.equal(ready.snapshot().recognition, 'rate_limited');
});

test('confirmed missing speech scope fails before resource download or recognition', async () => {
  const voice = new VoiceTranscriber({ executable: 'fake', checkScope: async () => ({ permission: 'missing' }),
    run: async () => { throw new Error('must not run'); } });
  await assert.rejects(voice.transcribe({ messageId: 'om_one', fileKey: 'file_one', durationMs: 1000 }), { code: 'VOICE_SCOPE_MISSING' });
});

test('native scope errors and unsupported subscriptions are never retried as throttling', async () => {
  for (const [payload, code] of [[{ code: 99991672, msg: 'scope denied' }, 'VOICE_SCOPE_MISSING'],
    [{ ok: false, error: { code: 99991400, retryable: true, message: 'free plan not supported' } }, 'VOICE_SERVICE_UNAVAILABLE']]) {
    const voice = new VoiceTranscriber({ executable: 'fake', run: async () => ({ code: 1, stdout: '', stderr: JSON.stringify(payload) }),
      sleep: async () => { throw new Error('must not retry'); } });
    await assert.rejects(voice.recognize('request.json'), { code });
  }
});

test('binding expiry/cap removes only expected regular records and expired replies cannot resume', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'binding-retention-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.now(), id = '11111111-1111-4111-8111-111111111111';
  const write = (name, timestamp) => fs.writeFileSync(path.join(root, name + '.json'), JSON.stringify({ version: 1, messageId: name,
    executor: 'claude', nativeId: id, recipientOpenId: 'ou_owner', chatId: 'oc_chat', createdAt: new Date(timestamp).toISOString() }));
  const msg = { reply_to: 'om_expired', chat_type: 'p2p', sender_type: 'user', sender_id: 'ou_owner', chat_id: 'oc_chat' };
  write('om_expired', now - NOTIFICATION_TTL_MS - 1);
  write('om_new', now); write('om_older', now - 1000); write('om_future', now + 3600000);
  fs.writeFileSync(path.join(root, 'om_malformed.json'), '{'); fs.writeFileSync(path.join(root, 'unrelated.txt'), 'keep');
  assert.equal(readNotificationBinding(msg, { directory: root, now }).kind, 'expired');
  assert.deepEqual(pruneNotificationBindings({ directory: root, now, maxRecords: 1 }), { removed: 4, kept: 1 });
  assert.deepEqual(fs.readdirSync(root).sort(), ['om_new.json', 'unrelated.txt']);
  assert.equal(readNotificationBinding(msg, { directory: root, now }).kind, 'missing');
});

test('binding reader and cleanup refuse linked directories and do not follow linked files', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'binding-links-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'target'), linked = path.join(root, 'linked'); fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'om_keep.json'), '{}');
  fs.symlinkSync(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => pruneNotificationBindings({ directory: linked }), /Unsafe/);
  assert.equal(readNotificationBinding({ reply_to: 'om_keep' }, { directory: linked }).kind, 'invalid');
  assert.ok(fs.existsSync(path.join(target, 'om_keep.json')));
});
