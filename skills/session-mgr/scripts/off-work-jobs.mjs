import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const offWorkReportDirectory = () => path.join(os.homedir(), '.agents', '.sessionmgr', 'off-work');

export function reportPath(id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid off-work job ID');
  return path.join(offWorkReportDirectory(), `${id}.json`);
}

export function writeOffWorkReport(id, report) {
  const file = reportPath(id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(report, null, 2), { flag: 'wx' });
  fs.renameSync(temporary, file);
}

export async function startOffWorkJob() {
  if (process.platform !== 'win32') throw new Error('下班功能当前仅支持 Windows');
  const id = randomUUID(), file = reportPath(id);
  writeOffWorkReport(id, { status: 'starting', id, createdAt: new Date().toISOString() });
  const child = spawn(process.execPath, [fileURLToPath(new URL('./off-work-worker.mjs', import.meta.url)), id], {
    detached: true, windowsHide: true, stdio: 'ignore', cwd: path.dirname(file),
  });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  // Do not authorize termination until the worker proves it can survive its caller.
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (state.status === 'ready') {
      fs.writeFileSync(`${file}.go`, id, { flag: 'wx' });
      return { status: 'scheduled', id, reportPath: file, message: '下班将在后台执行；当前客户端也可能关闭。结果写入报告。' };
    }
    if (state.status === 'failed') return { ...state, reportPath: file };
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return { status: 'failed', code: 'worker_handshake_timeout', reportPath: file, message: '后台执行器未就绪，未授权关闭。请通过飞书发送“下班”。' };
}
