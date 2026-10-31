import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { connectCodex, resolveCodexExecutable } from '../scripts/codex-rpc.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'session-mgr-launch-')));
  t.after(async () => {
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('session-mgr-launch-'));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return root;
}

test('executable resolution respects overrides and distinguishes missing from failed installations', async t => {
  const root = await fixture(t);
  const env = { ...process.env, CODEX_APP_RUNTIME_CLI_PATH: process.execPath };
  const native = await resolveCodexExecutable({ env });
  assert.equal(native.command, process.execPath);
  await assert.rejects(resolveCodexExecutable({ codexBin: path.join(root, 'missing'), env }), { code: 'codex_not_found' });
  const broken = path.join(root, process.platform === 'win32' ? 'broken.exe' : 'broken');
  await fs.writeFile(broken, 'not an executable');
  await assert.rejects(connectCodex({ root, codexBin: broken, timeoutMs: 3000 }), { code: 'codex_start_failed' });
});

test('Windows PATH finds npm cmd/bat launchers and preserves spaces and shell characters', async t => {
  if (process.platform !== 'win32') return;
  const root = await fixture(t);
  const bin = path.join(root, 'npm bin &(local) %SESSION_MGR_TEST_VALUE%!'); await fs.mkdir(bin);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['path', 'codex_app_runtime_cli_path'].includes(key.toLowerCase())));
  Object.assign(env, { Path: bin, SESSION_MGR_TEST_VALUE: 'MUST_NOT_EXPAND' });
  await fs.writeFile(path.join(bin, 'cli.mjs'), `
    import {createInterface} from 'node:readline';
    if(process.argv.includes('--version')) { console.log(JSON.stringify(process.argv.slice(2))); }
    else { createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined) console.log(JSON.stringify({id:m.id,result:m.method==='initialize'?{}:{data:[],nextCursor:null}}));}); }
  `);
  for (const extension of ['cmd', 'bat']) {
    const wrapper = path.join(bin, `codex.${extension}`);
    await fs.writeFile(wrapper, `@"${process.execPath}" "%~dp0cli.mjs" %*\r\n`);
    const args = ['--version', 'space & | ( ) %SESSION_MGR_TEST_VALUE% !'];
    const launch = await resolveCodexExecutable({ env, args });
    assert.equal(launch.executable, wrapper);
    const result = spawnSync(launch.command, launch.args, { ...launch.options, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), args);
    const rpc = await connectCodex({ root, codexBin: wrapper, timeoutMs: 5000 });
    try { assert.deepEqual(await rpc.call('thread/list'), { data: [], nextCursor: null }); } finally { await rpc.close(); }
    await fs.unlink(wrapper);
  }
  const exe = path.join(bin, 'codex.exe'); await fs.writeFile(exe, 'fixture');
  await fs.writeFile(path.join(bin, 'codex.cmd'), 'fixture');
  assert.equal((await resolveCodexExecutable({ env })).executable, exe);
});
