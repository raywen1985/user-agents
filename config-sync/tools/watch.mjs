import fs from 'node:fs';
import path from 'node:path';
import { configurationIdentity, execute, definitions, rawSignature, gitBusy } from './engine.mjs';
import { secureDirectory, replace, stamp } from './transaction.mjs';
import { fail, stable } from './documents.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function watch(ctx, { once = false, emit = console.log, intervalMs = 30000, debounceMs = 2000 } = {}) {
  execute(ctx, 'check');
  secureDirectory(ctx.stateRoot);
  const stopFile = path.join(ctx.stateRoot, 'watch.stop');
  if (fs.existsSync(stopFile)) fail('watch-disabled');
  const identity = configurationIdentity(ctx), statusFile = path.join(ctx.stateRoot, 'watcher.json');
  let stopped = false, dirty = true, lastScan = 0, lastMessage = '', failures = 0, retryAt = 0;
  const report = value => {
    const message = stable(value);
    if (message !== lastMessage) {
      emit(message); lastMessage = message;
      replace(statusFile, Buffer.from(stable({ pid: process.pid, ...value }) + '\n'), stamp(statusFile));
      fs.appendFileSync(path.join(ctx.stateRoot, 'sync.log'), new Date().toISOString() + ' ' + message + '\n', { mode: 0o600 });
    }
  };
  const listeners = [];
  const watched = new Set();
  const refresh = () => {
    for (const d of definitions(ctx)) for (const file of [d.local, d.source]) {
      const dir = path.dirname(file);
      if (watched.has(dir) || !fs.existsSync(dir)) continue;
      const observer = fs.watch(dir, (_, filename) => {
        if (!filename || definitions(ctx).some(x => [x.local, x.source].includes(path.join(dir, String(filename))))) dirty = true;
      });
      observer.on('error', () => { dirty = true; watched.delete(dir); });
      listeners.push(observer); watched.add(dir);
    }
  };
  const stop = () => { stopped = true; };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    report({ status: 'watching' });
    do {
      if (stopped || fs.existsSync(stopFile)) break;
      if (configurationIdentity(ctx) !== identity) { report({ status: 'needs-rebaseline' }); break; }
      refresh();
      if ((dirty || Date.now() - lastScan >= intervalMs) && Date.now() >= retryAt) {
        dirty = false; lastScan = Date.now();
        try {
          if (gitBusy(ctx)) { dirty = true; report({ status: 'repository-busy' }); }
          else {
            const before = rawSignature(ctx);
            await wait(debounceMs);
            if (stopped || fs.existsSync(stopFile)) break;
            if (configurationIdentity(ctx) !== identity) { report({ status: 'needs-rebaseline' }); break; }
            if (before !== rawSignature(ctx) || gitBusy(ctx)) { dirty = true; report({ status: 'waiting-for-stable-files' }); }
            else { report(execute(ctx, 'reconcile')); failures = 0; }
          }
        } catch (e) {
          report({ status: e.code && e.name === 'Error' ? e.code : 'sync-failed', ...(e.detail ?? {}) });
          dirty = true; retryAt = Date.now() + Math.min(60000, 2000 * 2 ** Math.min(failures++, 5));
        }
      }
      if (once) break;
      await wait(500);
    } while (!stopped);
  } finally {
    for (const listener of listeners) listener.close();
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    if (stopped || fs.existsSync(stopFile)) report({ status: 'stopped' });
  }
}
