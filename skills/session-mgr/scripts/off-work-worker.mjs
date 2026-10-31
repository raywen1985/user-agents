import fs from 'node:fs';
import { executeOffWork, windowsOffWork } from './off-work.mjs';
import { reportPath, writeOffWorkReport } from './off-work-jobs.mjs';

const id = process.argv[2];
const file = reportPath(id);
try {
  const checked = await windowsOffWork({ action: 'worker-check', pid: process.pid });
  if (!checked.independent) throw new Error('后台执行器仍受调用方 Job 管理，未关闭客户端。请通过飞书发送“下班”。');
  writeOffWorkReport(id, { status: 'ready', id, workerPid: process.pid });
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(`${file}.go`) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  if (!fs.existsSync(`${file}.go`) || fs.readFileSync(`${file}.go`, 'utf8') !== id) throw new Error('未收到调用者握手，未关闭客户端。');
  fs.unlinkSync(`${file}.go`);
  await new Promise(resolve => setTimeout(resolve, 1000));
  writeOffWorkReport(id, { status: 'running', id, workerPid: process.pid });
  const result = await executeOffWork({ detachedWorker: true });
  writeOffWorkReport(id, { ...result, id });
} catch (error) {
  writeOffWorkReport(id, { status: 'failed', id, message: error.message });
}
