import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fail } from './session-store.mjs';
import { resolveCodexExecutable } from './codex-executable.mjs';
export { resolveCodexExecutable } from './codex-executable.mjs';

// Each connection owns only its helper process, never the user's Codex process.
export async function connectCodex({ root, codexBin, serverSocket, timeoutMs = 30000 } = {}) {
  const args = serverSocket ? ['app-server', 'proxy', '--sock', serverSocket] : ['app-server', '--stdio'];
  const launch = await resolveCodexExecutable({ codexBin, args, env: { ...process.env, CODEX_HOME: root } });
  let child;
  try { child = spawn(launch.command, launch.args, { ...launch.options, stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch (error) { throw fail('codex_start_failed', `Codex was found at ${launch.executable}, but could not start: ${error.message}`); }
  let nextId = 0, stderr = '', closed = false, initialized = false;
  const pending = new Map();
  const rejectAll = error => { for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error); } pending.clear(); };
  child.on('error', error => { closed = true; rejectAll(fail('codex_start_failed', `Codex was found at ${launch.executable}, but could not start: ${error.message}`)); });
  child.on('exit', code => { closed = true; rejectAll(fail(initialized ? 'codex_disconnected' : 'codex_start_failed', `Codex at ${launch.executable} exited (${code}): ${stderr.slice(-1500)}`)); });
  child.stderr.setEncoding('utf8').on('data', data => { stderr = (stderr + data).slice(-4000); });
  child.stdin.on('error', error => rejectAll(fail('codex_disconnected', error.message)));
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return rejectAll(fail('codex_protocol_error', 'Non-JSON app-server response')); }
    if (message.method && message.id !== undefined) {
      // This client never starts/resumes turns or approves server requests.
      child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'SessionMgr does not accept server requests' } }) + '\n');
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(fail('codex_rpc_error', message.error.message || 'Codex request failed', { rpcCode: message.error.code }));
    else request.resolve(message.result);
  });
  const rpc = {
    call(method, params = {}) {
      if (closed) return Promise.reject(fail('codex_disconnected', 'Codex helper is closed'));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(fail('codex_timeout', `${method} timed out; do not automatically retry a deletion`)); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      });
    },
    async close() {
      lines.close(); child.stdin.end(); rejectAll(fail('codex_disconnected', 'Connection closed'));
      if (closed) return;
      await new Promise(resolve => { const timer = setTimeout(() => { child.kill(); resolve(); }, 1500); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
    },
  };
  try {
    await rpc.call('initialize', { clientInfo: { name: 'session_mgr', title: 'SessionMgr', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    initialized = true;
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    return rpc;
  } catch (error) { await rpc.close(); throw error; }
}

export async function withCodex(options, work) {
  if (options.rpc) return work(options.rpc);
  const rpc = await connectCodex(options);
  try { return await work(rpc); } finally { await rpc.close(); }
}
