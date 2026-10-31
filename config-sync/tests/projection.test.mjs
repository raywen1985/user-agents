import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { project, validateSource, validatePolicy, portable, expand, safeString, secretValues, sourceCommand, installedCommand, commandId, merge } from '../tools/projection.mjs';
import { parse, edit, stable, encode, decode } from '../tools/documents.mjs';

const policy = validatePolicy(JSON.parse(fs.readFileSync(new URL('../policy.json', import.meta.url))));
const ctx = { policy, agentsRoot: 'D:/Profiles/甲 用户/.agents', userHome: 'D:/Profiles/甲 用户', tempRoot: 'D:/Temp', localAppData: 'D:/Local', nodePath: 'D:/Node/node.exe', secrets: [] };
const hook = (id, timeout = 10) => ({ type: 'command', command: sourceCommand(id), timeout });

test('secrets, runtime environment, trust and unknown preferences never enter projections', () => {
  const claude = { theme: 'dark', env: { ANTHROPIC_AUTH_TOKEN: 'synthetic-private-credential', API_TIMEOUT_MS: '2000', NEW_KEY: 'other-secret' }, unknown: 'private', permissions: { defaultMode: 'auto' } };
  const codex = { model: 'account-model', model_provider: 'custom', model_providers: { custom: { name: 'Custom', experimental_bearer_token: 'second-private-credential', base_url: 'http://localhost:9000/v1' } }, projects: { private: { trust_level: 'trusted' } }, hooks: { state: { private: { trusted_hash: 'trusted' } } }, mcp_servers: { node_repl: { env: { TOKEN: 'runtime-private' } } }, desktop: { newUnknown: 'private' } };
  const c = { ...ctx, secrets: secretValues([claude, codex]) };
  const output = [project(claude, 'claude', c).value, project(codex, 'codex', c).value];
  assert.equal(output[0].env.API_TIMEOUT_MS, '2000');
  assert.equal(output[1].model_providers.custom.base_url, 'http://localhost:9000/v1');
  assert.doesNotMatch(JSON.stringify(output), /credential|runtime-private|trusted_hash|projects|node_repl|newUnknown/);
  assert.throws(() => project({ model: 'synthetic-private-credential' }, 'claude', c), /secret-value-reused/);
  assert.throws(() => validateSource(claude, 'claude', c), /source-not-a-portable-projection/);
});
test('URL credentials and unknown encoded payloads are rejected or excluded', () => {
  for (const url of ['https://user:pass@example.test/v1', 'https://example.test/?token=secret', 'https://example.test/#secret']) assert.throws(() => safeString(url, ctx));
  const command = 'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + Buffer.from("Write-Host 'synthetic-private-credential'", 'utf16le').toString('base64');
  const result = project({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } }, 'claude', ctx);
  assert.equal(result.report.skippedHooks, 1); assert.deepEqual(result.value, {});
});
test('roots use complete boundaries, longest match and target-specific expansion', () => {
  assert.equal(portable('d:\\Profiles\\甲 用户\\.agents\\hooks\\file.ps1', ctx), '${AGENTS_ROOT}/hooks/file.ps1');
  assert.equal(portable('D:/Temp/job', ctx), '${TEMP}/job');
  assert.equal(portable('~/config', ctx), '${USER_HOME}/config');
  assert.equal(expand('${AGENTS_ROOT}/hooks/file.ps1', { ...ctx, agentsRoot: 'E:/Other PC/.agents' }), 'E:/Other PC/.agents/hooks/file.ps1');
  for (const file of ['D:/Profiles/甲 用户-suffix/a', 'C:/other/file', '//server/share/file', '${UNKNOWN}/a', '${USER_HOME}/../other', '${USER_HOME}/${TEMP}']) assert.throws(() => portable(file, ctx));
  assert.equal(portable('//d/Profiles/甲 用户/document', ctx), '${USER_HOME}/document');
});
test('permission projection does not widen a machine-specific grant', () => {
  const result = project({ permissions: { allow: ['Read(D:/Temp/claude/**)', 'Read(//c/Users/*/Temp/**)', 'Bash(curl --token=private)'], additionalDirectories: ['D:/Temp/claude'] } }, 'claude', ctx);
  assert.deepEqual(result.value.permissions.allow, ['Read(${TEMP}/claude/**)']);
  assert.equal(result.report.skippedPaths, 2);
});
test('known encoded hooks normalize without execution and rehydrate for another PC', () => {
  const a = { ...ctx, agentsRoot: ctx.userHome + '/.agents' };
  const b = { ...ctx, userHome: 'E:/Second Person', agentsRoot: 'F:/Shared Agents' };
  for (const id of ['claude-turn', 'codex-turn', 'claude-status', 'lark-notify', 'codex-noop']) {
    assert.equal(commandId(installedCommand(id, a), a), id);
    assert.equal(commandId(installedCommand(id, b), b), id);
    assert.equal(commandId(sourceCommand(id), b), id);
  }
  const lark = installedCommand('lark-notify', a);
  assert.equal(commandId(lark.replace('Profiles', 'PROFILES').replace('lark-notify.ps1', 'LARK-NOTIFY.PS1'), a), 'lark-notify');
});
test('owned hook policy conflicts and ambiguous duplicates fail closed', () => {
  assert.throws(() => project({ hooks: { Stop: [{ hooks: [hook('lark-notify', 20)] }] } }, 'claude', ctx), /owner-policy-conflict/);
  assert.throws(() => project({ hooks: { Stop: [{ hooks: [hook('claude-turn'), hook('claude-turn')] }] } }, 'claude', ctx), /duplicate-owned-hook/);
});
test('merge preserves local unknowns, secrets and other handlers, deduplicates permission grants', () => {
  const original = { env: { ANTHROPIC_AUTH_TOKEN: 'private' }, permissions: { allow: ['Read(D:/Temp/a)', 'Read(C:/machine/b)'] }, custom: { keep: true }, hooks: { Stop: [{ hooks: [{ ...hook('claude-turn'), command: installedCommand('claude-turn', ctx), custom: 'keep' }, { type: 'command', command: 'user-owned-command' }] }] } };
  const source = { permissions: { allow: ['Read(${TEMP}/a)', 'Read(${TEMP}/new)'] }, hooks: { Stop: [{ hooks: [hook('claude-turn')] }] } };
  const merged = merge(original, source, 'claude', ctx);
  assert.equal(merged.env.ANTHROPIC_AUTH_TOKEN, 'private');
  assert.deepEqual(merged.permissions.allow, ['Read(D:/Temp/a)', 'Read(C:/machine/b)', 'Read(D:/Temp/new)']);
  assert.equal(merged.hooks.Stop[0].hooks.length, 2);
  assert.equal(merged.hooks.Stop[0].hooks[0].custom, 'keep');
  assert.equal(stable(merge(merged, source, 'claude', ctx)), stable(merged));
});
test('desktop native notification wrapper remains machine-local across merge', () => {
  const bridge = ['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'D:/Profiles/甲 用户/.agents/hooks/Invoke-CodexNotifyBridge.ps1'];
  const notify = ['D:/Local/OpenAI/Codex/runtimes/cua_node/v1/bin/codex-computer-use.exe', 'turn-ended', '--previous-notify', JSON.stringify(bridge)];
  const projected = project({ notify }, 'codex', ctx).value;
  assert.doesNotMatch(JSON.stringify(projected), /cua_node|v1\/bin/);
  const installed = merge({ notify }, projected, 'codex', ctx);
  assert.deepEqual(installed.notify.slice(0, 3), notify.slice(0, 3));
  assert.equal(project(installed, 'codex', ctx).value.notify[7], '${AGENTS_ROOT}/hooks/Invoke-CodexNotifyBridge.ps1');
});
test('JSONC edits preserve unrelated comments and reject duplicate keys without excerpts', () => {
  const text = '{ // personal comment\n "model": "old", "unknown": {"token": "synthetic-secret"},\n}\n';
  const value = parse(text, 'json'); value.model = 'new';
  const result = edit(text, 'json', value);
  assert.match(result, /personal comment/); assert.match(result, /synthetic-secret/);
  assert.throws(() => parse('{"x":"synthetic-secret","x":2}', 'json'), e => e.code === 'duplicate-json-key' && !e.message.includes('synthetic-secret'));
  assert.throws(() => parse('{"__proto__":{}}', 'json'), /unsafe-key/);
});
test('TOML handles quoted tables, inline tables, arrays, comments and unknown tables', () => {
  for (const text of [
    'model = "old" # preserve\n[tui]\nstatus_line = ["one", "two"]\n[unknown]\nkeep = true\n',
    'model = "old"\ntui = { status_line = ["one"], local = 1 }\n[plugins."existing@market"]\nenabled = true\n',
    'model = "old"\n"tui"."status_line" = ["one"]\n[[unknown]]\nname="keep"\n'
  ]) {
    const after = parse(text, 'toml'); after.model = 'new'; after.tui.status_line = ['two', 'one']; after.tui.other = false;
    after.plugins ??= {}; after.plugins['new@market'] = { enabled: true };
    const result = edit(text, 'toml', after);
    assert.equal(stable(parse(result, 'toml')), stable(after));
    if (text.includes('# preserve')) assert.match(result, /# preserve/);
    assert.equal(edit(result, 'toml', after), result);
  }
  assert.throws(() => parse('model="synthetic-secret"\nmodel="x"', 'toml'), e => e.code === 'invalid-toml' && !e.message.includes('synthetic-secret'));
});
test('JSON encodings and unchanged text survive round trips', () => {
  for (const format of [{ encoding: 'utf8', bom: false }, { encoding: 'utf8', bom: true }, { encoding: 'utf16le', bom: true }]) {
    const bytes = encode('{"model":"one"}\r\n', format);
    const decoded = decode(bytes);
    const value = parse(decoded.text, 'json'); value.model = 'two';
    const edited = encode(edit(decoded.text, 'json', value), decoded);
    assert.equal(decode(edited).encoding, format.encoding);
    assert.equal(decode(edited).bom, format.bom);
    assert.match(decode(edited).text, /\r\n/);
    assert.equal(parse(decode(edited).text, 'json').model, 'two');
  }
});
