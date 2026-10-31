import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { context, execute, direction } from '../tools/engine.mjs';
import { stamp, pending, lock } from '../tools/transaction.mjs';
import { hash, stable } from '../tools/documents.mjs';
import { watch } from '../tools/watch.mjs';

const realCode = fileURLToPath(new URL('..', import.meta.url));
const basePolicy = JSON.parse(fs.readFileSync(path.join(realCode, 'policy.json')));
const write = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v)); };
function fixture(t, both = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-config-sync-test-'));
  t.after(() => { if (!path.basename(root).startsWith('agent-config-sync-test-')) throw new Error('unsafe cleanup'); fs.rmSync(root, { recursive: true, force: true }); });
  const ctx = context({ agentsRoot: path.join(root, 'agents'), userHome: path.join(root, 'PC 用户'), tempRoot: path.join(root, 'temporary'), codeRoot: realCode });
  const policy = { ...basePolicy, clients: both ? ['claude', 'codex'] : ['claude'], commands: [], providers: [], mcpServers: [], plugins: [] };
  write(ctx.policyPath, policy);
  const local = path.join(ctx.userHome, '.claude/settings.json'), source = path.join(ctx.sourceRoot, 'claude.settings.json');
  write(local, { model: 'one', theme: 'dark', env: { ANTHROPIC_AUTH_TOKEN: 'synthetic-private-token' }, unknown: { keep: 1 } });
  if (both) {
    write(path.join(ctx.codexRoot, 'config.toml'), 'model="one"\n[projects."private"]\ntrust_level="trusted"\n');
    write(path.join(ctx.codexRoot, 'hooks.json'), { hooks: {}, localUnknown: true });
  }
  return { ctx, local, source, root, policy };
}
test('two-sided changes always conflict, including equal new projections', () => {
  const state = { identity: 'i', localHash: hash(stable({ model: 'old' })), sourceHash: hash(stable({ model: 'old' })) };
  assert.equal(direction({ identity: 'i', state, localViews: { model: 'new' }, sourceViews: { model: 'new' } }), 'conflict');
  assert.equal(direction({ identity: 'other', state, localViews: {}, sourceViews: {} }), 'needs-rebaseline');
});
test('dry-run is read-only, collection excludes credentials, repeats do not rewrite, installation preserves unknowns', t => {
  const { ctx, local, source } = fixture(t, true);
  const original = stamp(local);
  assert.equal(execute(ctx, 'collect', { whatIf: true }).changedFiles, 3);
  assert.equal(fs.existsSync(ctx.stateRoot), false);
  assert.equal(execute(ctx, 'collect').changedFiles, 3);
  assert.equal(stamp(local), original);
  assert.doesNotMatch(fs.readFileSync(source, 'utf8'), /synthetic-private|AUTH_TOKEN|unknown/);
  const before = fs.statSync(source).mtimeMs;
  assert.equal(execute(ctx, 'collect').changedFiles, 0);
  assert.equal(fs.statSync(source).mtimeMs, before);
  const src = JSON.parse(fs.readFileSync(source)); src.model = 'two'; write(source, src);
  assert.equal(execute(ctx, 'install').changedFiles, 1);
  const installed = JSON.parse(fs.readFileSync(local));
  assert.equal(installed.model, 'two'); assert.equal(installed.env.ANTHROPIC_AUTH_TOKEN, 'synthetic-private-token'); assert.equal(installed.unknown.keep, 1);
  assert.equal(execute(ctx, 'reconcile').status, 'unchanged');
});
test('collection and installation reject double edits until a direction is explicitly selected', t => {
  const { ctx, local, source } = fixture(t);
  execute(ctx, 'collect');
  write(local, { model: 'same-new', theme: 'dark' }); write(source, { model: 'same-new', theme: 'dark' });
  assert.throws(() => execute(ctx, 'collect'), /conflict/);
  assert.throws(() => execute(ctx, 'install'), /conflict/);
  assert.equal(execute(ctx, 'collect', { resolveConflict: 'PreferLocal' }).status, 'success');
  assert.equal(execute(ctx, 'check').status, 'ready');
});
test('retained local union entries get their own baseline rather than immediately flowing back', t => {
  const { ctx, local, source } = fixture(t);
  write(local, { model: 'one', permissions: { allow: ['Read(local.txt)'] } }); execute(ctx, 'collect');
  write(source, { model: 'one', permissions: { allow: ['Read(shared.txt)'] } });
  execute(ctx, 'install');
  assert.deepEqual(JSON.parse(fs.readFileSync(local)).permissions.allow, ['Read(local.txt)', 'Read(shared.txt)']);
  assert.equal(execute(ctx, 'reconcile').status, 'unchanged');
  assert.deepEqual(JSON.parse(fs.readFileSync(source)).permissions.allow, ['Read(shared.txt)']);
});
test('missing files and policy migration cannot silently clear or overwrite a source', t => {
  const { ctx, local, source, policy } = fixture(t); execute(ctx, 'collect');
  const before = stamp(source); fs.unlinkSync(local);
  assert.throws(() => execute(ctx, 'collect'), /configuration-missing/); assert.equal(stamp(source), before);
  write(local, { model: 'one', theme: 'dark' });
  write(ctx.policyPath, { ...policy, claudeFields: ['model'] });
  assert.throws(() => execute(ctx, 'install'), /source-not-a-portable-projection/);
  // A narrower policy requires an explicit edit of the source too.
  write(source, { model: 'one' });
  assert.throws(() => execute(ctx, 'collect'), /needs-rebaseline/);
  assert.equal(execute(ctx, 'collect', { rebaseline: true }).status, 'success');
});
test('late source-side edits never become a false synchronized baseline', t => {
  const { ctx, local, source } = fixture(t); execute(ctx, 'collect');
  const originalLocal = stamp(local), stateFile = path.join(ctx.stateRoot, 'state.json'), originalState = stamp(stateFile);
  write(source, { model: 'two', theme: 'dark' });
  ctx.fault = (point, entry) => { if (point === 'after-publish' && entry.path === local) write(source, { model: 'three', theme: 'dark' }); };
  assert.throws(() => execute(ctx, 'install'), /concurrent-change/);
  assert.equal(stamp(local), originalLocal); assert.equal(stamp(stateFile), originalState);
  assert.equal(JSON.parse(fs.readFileSync(source)).model, 'three');
});
test('three-file publication failure rolls back earlier replacements exactly', t => {
  const { ctx, local, source } = fixture(t, true); execute(ctx, 'collect');
  const files = [source, path.join(ctx.sourceRoot, 'codex.config.toml'), path.join(ctx.sourceRoot, 'codex.hooks.json')];
  const originals = files.map(stamp);
  write(local, { model: 'two' }); write(path.join(ctx.codexRoot, 'config.toml'), 'model="two"\n');
  ctx.fault = (point, entry) => { if (point === 'before-publish' && entry.index === 1) throw new Error('synthetic failure'); };
  assert.throws(() => execute(ctx, 'collect'), /synthetic failure/);
  assert.deepEqual(files.map(stamp), originals);
});
test('crash after replacement before progress/state publication is recoverable', t => {
  const { ctx, local, source } = fixture(t); execute(ctx, 'collect'); const original = stamp(source);
  write(local, { model: 'two' });
  ctx.fault = (point, entry) => { if (point === 'after-publish' && entry.index === 0) throw Object.assign(new Error('crash'), { simulatedCrash: true }); };
  assert.throws(() => execute(ctx, 'collect'), /crash/);
  const ids = pending(ctx.stateRoot); assert.equal(ids.length, 1);
  assert.throws(() => execute(ctx, 'collect'), /recovery-required/);
  assert.equal(execute(ctx, 'recover', { whatIf: true, transactionId: ids[0] }).status, 'preview');
  assert.notEqual(stamp(source), original);
  assert.equal(execute(ctx, 'recover', { transactionId: ids[0] }).status, 'recovered-rollback');
  assert.equal(stamp(source), original);
});
test('external changes during rollback are retained and require explicit recovery', t => {
  const { ctx, local, source } = fixture(t); execute(ctx, 'collect'); write(local, { model: 'two' });
  ctx.fault = (point, entry) => {
    if (point === 'after-publish' && entry.index === 0) { write(source, { model: 'external-writer' }); throw new Error('failure'); }
  };
  assert.throws(() => execute(ctx, 'collect'), /recovery-required/);
  assert.equal(JSON.parse(fs.readFileSync(source)).model, 'external-writer');
});
test('watch performs bounded reconciliation without enabling any system task', async t => {
  const { ctx, local, source } = fixture(t); execute(ctx, 'collect');
  write(local, { model: 'watched' });
  const emitted = [];
  await watch(ctx, { once: true, debounceMs: 10, emit: s => emitted.push(JSON.parse(s)) });
  assert.equal(JSON.parse(fs.readFileSync(source)).model, 'watched');
  assert.equal(emitted.at(-1).status, 'success');
  assert.equal(execute(ctx, 'reconcile').status, 'unchanged');
});
test('a portable source installs into another user root without the source credentials', t => {
  const a = fixture(t), b = fixture(t);
  write(a.local, { model: 'shared', permissions: { additionalDirectories: [path.join(a.ctx.userHome, 'documents')] }, env: { ANTHROPIC_AUTH_TOKEN: 'source-private-credential' } });
  execute(a.ctx, 'collect');
  write(b.source, fs.readFileSync(a.source, 'utf8'));
  execute(b.ctx, 'install');
  const installed = JSON.parse(fs.readFileSync(b.local));
  assert.equal(installed.model, 'shared');
  assert.equal(installed.env.ANTHROPIC_AUTH_TOKEN, 'synthetic-private-token');
  assert.equal(installed.permissions.additionalDirectories[0], path.join(b.ctx.userHome, 'documents').replaceAll('\\', '/'));
  assert.doesNotMatch(fs.readFileSync(b.source, 'utf8'), /source-private-credential/);
});
test('provider authentication is a precondition to writing any target', t => {
  const { ctx, source, local, policy } = fixture(t, true);
  write(ctx.policyPath, { ...policy, providers: ['custom'] }); execute(ctx, 'collect');
  write(path.join(ctx.sourceRoot, 'codex.config.toml'), 'model_provider="custom"\n[model_providers.custom]\nname="Custom"\nbase_url="https://example.test/v1"\nrequires_openai_auth=true\n');
  write(source, { model: 'would-change' }); const before = stamp(local);
  assert.throws(() => execute(ctx, 'install'), /provider-auth-required/);
  assert.equal(stamp(local), before);
});
test('recovery can finish a fully published transaction whose commit marker is missing', t => {
  const { ctx, local, source } = fixture(t); execute(ctx, 'collect'); write(local, { model: 'two' });
  ctx.fault = (point, entry) => { if (point === 'after-publish' && entry.path.endsWith('state.json')) throw Object.assign(new Error('crash'), { simulatedCrash: true }); };
  assert.throws(() => execute(ctx, 'collect'), /crash/);
  const [id] = pending(ctx.stateRoot);
  assert.equal(execute(ctx, 'recover', { transactionId: id }).status, 'recovered-commit');
  assert.equal(JSON.parse(fs.readFileSync(source)).model, 'two');
  assert.equal(execute(ctx, 'reconcile').status, 'unchanged');
});
test('a live operation lock blocks another writer without altering the owner', t => {
  const { ctx } = fixture(t);
  lock(ctx.stateRoot, () => {
    const before = stamp(path.join(ctx.stateRoot, 'operation.lock'));
    assert.throws(() => execute(ctx, 'collect'), /busy-lock/);
    assert.equal(stamp(path.join(ctx.stateRoot, 'operation.lock')), before);
  });
});
