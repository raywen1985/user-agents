import fs from 'node:fs/promises';
import path from 'node:path';
import { defaultRoot, fail, probeProcesses, safeStat } from './session-store.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function probeCurrentProcess(record) {
  if (process.platform === 'win32') {
    const [result] = await probeProcesses([{ ...record, key: 'current' }]);
    return result?.state === 'active';
  }
  if (process.platform === 'linux') {
    // Linux procStart is /proc/<pid>/stat field 22 (starttime in clock ticks).
    const stat = await fs.readFile(`/proc/${record.pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return !['Z', 'X'].includes(fields[0]) && fields[19] === record.procStart;
  }
  throw fail('current_session_unverified', 'Current process start identity cannot be verified on this platform');
}

export async function resolveCurrentRuntime(options = {}) {
  const env = options.runtimeEnv ?? process.env;
  const sessionId = env.CLAUDE_CODE_SESSION_ID;
  const pidText = env.CLAUDE_PID;
  if (typeof sessionId !== 'string' || !UUID.test(sessionId)
    || typeof pidText !== 'string' || !/^[1-9][0-9]*$/.test(pidText) || !Number.isSafeInteger(Number(pidText))) {
    throw fail('current_session_unverified', 'Run inside a fresh Claude Code shell tool call with CLAUDE_CODE_SESSION_ID and CLAUDE_PID; cached skill text is not current identity');
  }
  const pid = Number(pidText);
  let root, record;
  try {
    root = await fs.realpath(defaultRoot(options.root));
    const relative = path.join('sessions', `${pid}.json`);
    const stat = await safeStat(root, relative);
    if (!stat?.isFile()) throw new Error('Current process registry is missing');
    record = JSON.parse((await fs.readFile(path.join(root, relative), 'utf8')).replace(/^\uFEFF/, ''));
  } catch (error) {
    throw fail('current_session_unverified', `Cannot verify the calling Claude process registry: ${error.message}`);
  }
  if (record.pid !== pid || typeof record.sessionId !== 'string' || !UUID.test(record.sessionId)) {
    throw fail('current_session_unverified', 'Current process registry has an invalid PID or Session ID');
  }
  if (record.sessionId.toLowerCase() !== sessionId.toLowerCase()) {
    throw fail('current_session_mismatch', 'Shell Session and live process registry disagree, possibly after resume; no deletion is permitted', {
      shellSessionId: sessionId.toLowerCase(), registrySessionId: record.sessionId.toLowerCase(), pid,
    });
  }
  const procStart = record.procStartFt ?? record.procStart;
  if (typeof procStart !== 'string' || !procStart.trim()) {
    throw fail('current_session_unverified', 'Current process registry has no verifiable process start identity');
  }
  try {
    if (!await (options.probeCurrent ?? probeCurrentProcess)({ pid, procStart })) throw new Error('Process is gone or its PID was reused');
  } catch (error) {
    throw fail('current_session_unverified', `Cannot verify the calling Claude process identity: ${error.message}`);
  }
  return { id: sessionId.toLowerCase(), pid, procStart, root };
}
