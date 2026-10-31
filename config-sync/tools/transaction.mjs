import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fail, hash, SyncError } from './documents.mjs';

const helper = fileURLToPath(new URL('./file-io.ps1', import.meta.url));
export const stamp = file => {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('unsupported-file-type');
    return hash(fs.readFileSync(file));
  } catch (e) { if (e.code === 'ENOENT') return 'missing'; throw e; }
};
export function secureDirectory(dir) {
  // Validate existing ancestors before creating material containing credentials.
  for (let p = path.resolve(dir); p !== path.dirname(p); p = path.dirname(p)) {
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) fail('reparse-directory');
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    try { execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Operation', 'SecureDirectory', '-Target', dir], { windowsHide: true, stdio: 'pipe', timeout: 15000 }); }
    catch { fail('secure-directory-failed'); }
  } else fs.chmodSync(dir, 0o700);
}
export function durable(file, bytes) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
export function replace(file, bytes, expected) {
  if (stamp(file) !== expected) fail('concurrent-change');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const scratch = path.join(path.dirname(file), '.config-sync-' + randomUUID());
  secureDirectory(scratch);
  const candidate = path.join(scratch, 'candidate');
  durable(candidate, bytes);
  try {
    if (process.platform === 'win32') {
      try {
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Operation', 'Replace', '-Target', file, '-Candidate', candidate, '-ExpectedHash', expected], { windowsHide: true, stdio: 'pipe', timeout: 15000 });
      } catch (e) { fail(e.status === 42 ? 'concurrent-change' : 'atomic-replace-failed'); }
    } else {
      if (stamp(file) !== expected) fail('concurrent-change');
      if (expected !== 'missing') fs.chmodSync(candidate, fs.statSync(file).mode);
      fs.renameSync(candidate, file);
    }
  } finally {
    if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
    fs.rmdirSync(scratch);
  }
}
function writeJson(file, value) {
  replace(file, Buffer.from(JSON.stringify(value, null, 2) + '\n'), stamp(file));
}
export function lock(stateRoot, work) {
  secureDirectory(stateRoot);
  const lockPath = path.join(stateRoot, 'operation.lock');
  const reclaimPath = lockPath + '.reclaim';
  if (fs.existsSync(reclaimPath)) fail('busy-lock');
  let fd;
  try { fd = fs.openSync(lockPath, 'wx', 0o600); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let gate;
    try { gate = fs.openSync(reclaimPath, 'wx', 0o600); } catch { fail('busy-lock'); }
    try {
      // Serialize stale-lock recovery and re-read after acquiring the gate.
      // Otherwise two recoverers could unlink each other's new live lock.
      let owner;
      try { owner = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { fail('busy-lock'); }
      if (!Number.isInteger(owner.pid) || owner.pid <= 0) fail('busy-lock');
      let dead = false;
      try { process.kill(owner.pid, 0); } catch (x) { dead = x.code === 'ESRCH'; }
      if (!dead) fail('busy-lock');
      fs.unlinkSync(lockPath);
      try { fd = fs.openSync(lockPath, 'wx', 0o600); } catch { fail('busy-lock'); }
    } finally { fs.closeSync(gate); fs.unlinkSync(reclaimPath); }
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); fs.fsyncSync(fd);
    return work();
  } finally { fs.closeSync(fd); fs.unlinkSync(lockPath); }
}
function guardAll(guards) {
  for (const guard of guards) if (stamp(guard.path) !== guard.hash) fail('concurrent-change');
}
function rollback(plan, journalPath, fault) {
  let blocked = false;
  for (const entry of [...plan.entries].reverse()) {
    const current = stamp(entry.path);
    if (current === entry.before) continue;
    if (current !== entry.after) { blocked = true; continue; }
    try {
      fault?.('before-rollback', entry);
      if (entry.before === 'missing') {
        if (stamp(entry.path) !== entry.after) { blocked = true; continue; }
        fs.unlinkSync(entry.path);
      } else {
        const bytes = fs.readFileSync(entry.backup);
        if (hash(bytes) !== entry.before) { blocked = true; continue; }
        replace(entry.path, bytes, entry.after);
      }
    } catch { blocked = true; }
  }
  plan.status = blocked ? 'recovery-required' : 'rolled-back';
  writeJson(journalPath, plan);
  if (blocked) fail('recovery-required', { transaction: plan.id });
}
export function transact({ stateRoot, candidates, guards, fault }) {
  const entries = candidates.filter(c => hash(c.bytes) !== c.before);
  if (!entries.length) { guardAll(guards); return { changed: 0 }; }
  const id = randomUUID(), txDir = path.join(stateRoot, 'transactions', id), backupDir = path.join(stateRoot, 'backups', id);
  secureDirectory(txDir); secureDirectory(backupDir);
  guardAll(guards);
  const plan = { version: 1, id, status: 'prepared', guards, entries: [] };
  for (const [i, candidate] of entries.entries()) {
    if (stamp(candidate.path) !== candidate.before) fail('concurrent-change');
    const backup = path.join(backupDir, String(i));
    if (candidate.before !== 'missing') {
      const bytes = fs.readFileSync(candidate.path);
      if (hash(bytes) !== candidate.before) fail('concurrent-change');
      durable(backup, bytes);
    }
    const prepared = path.join(txDir, 'candidate-' + i);
    durable(prepared, candidate.bytes);
    plan.entries.push({ path: candidate.path, before: candidate.before, after: hash(candidate.bytes), backup, prepared });
  }
  const journalPath = path.join(txDir, 'journal.json');
  durable(journalPath, Buffer.from(JSON.stringify(plan, null, 2) + '\n'));
  try {
    guardAll(guards);
    for (const [i, entry] of plan.entries.entries()) {
      fault?.('before-publish', { ...entry, index: i });
      guardAll(guards.filter(g => !plan.entries.slice(0, i).some(x => x.path === g.path)));
      replace(entry.path, fs.readFileSync(entry.prepared), entry.before);
      fault?.('after-publish', { ...entry, index: i });
      if (stamp(entry.path) !== entry.after) fail('concurrent-change');
    }
    fault?.('before-commit', plan);
    guardAll(plan.entries.map(e => ({ path: e.path, hash: e.after })));
    guardAll(guards.filter(g => !plan.entries.some(e => e.path === g.path)));
    plan.status = 'committed'; writeJson(journalPath, plan);
    return { changed: entries.length, transaction: id };
  } catch (error) {
    // Fault injection is module-only; the production CLI cannot request a crash.
    if (error.simulatedCrash) throw error;
    rollback(plan, journalPath, fault);
    throw error;
  }
}
export function pending(stateRoot) {
  const dir = path.join(stateRoot, 'transactions');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(id => /^[a-f0-9-]{36}$/.test(id)).filter(id => {
    const file = path.join(dir, id, 'journal.json');
    if (!fs.existsSync(file)) return false; // Never published: no recovery needed.
    try { return ['prepared', 'recovery-required'].includes(JSON.parse(fs.readFileSync(file, 'utf8')).status); }
    catch { fail('invalid-recovery-journal'); }
  });
}
export function recover(stateRoot, id, allowedPaths) {
  if (!/^[a-f0-9-]{36}$/.test(id)) fail('invalid-transaction-id');
  const journalPath = path.join(stateRoot, 'transactions', id, 'journal.json');
  let plan; try { plan = JSON.parse(fs.readFileSync(journalPath, 'utf8')); } catch { fail('invalid-recovery-journal'); }
  if (plan.version !== 1 || plan.id !== id || !['prepared', 'recovery-required'].includes(plan.status)) fail('transaction-not-pending');
  for (const entry of plan.entries) {
    if (!allowedPaths.includes(entry.path) || path.dirname(entry.backup) !== path.join(stateRoot, 'backups', id) || path.dirname(entry.prepared) !== path.join(stateRoot, 'transactions', id)) fail('invalid-recovery-target');
    if (hash(fs.readFileSync(entry.prepared)) !== entry.after) fail('invalid-recovery-candidate');
  }
  const allPublished = plan.entries.every(e => stamp(e.path) === e.after);
  const guardsMatch = plan.guards.filter(g => !plan.entries.some(e => e.path === g.path)).every(g => allowedPaths.includes(g.path) && stamp(g.path) === g.hash);
  if (allPublished && guardsMatch) { plan.status = 'committed'; writeJson(journalPath, plan); return { status: 'recovered-commit', transaction: id }; }
  rollback(plan, journalPath);
  return { status: 'recovered-rollback', transaction: id };
}
