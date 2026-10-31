import { parentPort, workerData } from 'node:worker_threads';
import { listSessions } from '../claude-reader.mjs';

try {
  const result = await listSessions({ ...workerData, scope: 'all', metadataOnly: true, includeEvidence: true });
  parentPort.postMessage({ ok: true, result });
} catch {
  parentPort.postMessage({ ok: false });
}
