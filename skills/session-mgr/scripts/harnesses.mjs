import { createHash } from 'node:crypto';
import * as claude from './session-store.mjs';
import * as claudeCurrent from './current-session.mjs';
import * as codex from './codex-store.mjs';

// A new harness implements this contract; unsupported adapters never guess paths.
export const adapters = Object.freeze({
  claude: { name: 'Claude Code', list: claude.listSessions, preview: claude.previewDelete, execute: claude.executeDelete,
    previewCurrent: claudeCurrent.previewCurrentSessionDelete, executeCurrent: claudeCurrent.executeCurrentSessionDelete },
  codex: { name: 'Codex', list: codex.listCodexSessions, preview: codex.previewCodexDelete, execute: codex.executeCodexDelete,
    previewCurrent: codex.previewCurrentCodexDelete, executeCurrent: codex.executeCurrentCodexDelete },
});

export function resolveHarness(value, env = process.env) {
  if (value && value !== 'auto') {
    if (value === 'all' || adapters[value]) return value;
    throw claude.fail('unsupported_harness', `${value} has no implemented adapter; supported: claude, codex, all`);
  }
  const detected = [env.CODEX_THREAD_ID && 'codex', env.CLAUDE_CODE_SESSION_ID && env.CLAUDE_PID && 'claude'].filter(Boolean);
  if (detected.length !== 1) throw claude.fail('harness_required', 'Specify --harness claude or codex; the caller harness is missing or ambiguous');
  return detected[0];
}

const bound = (harness, fingerprint) => createHash('sha256').update(`${harness}:${fingerprint}`).digest('hex');
const session = (harness, value) => ({ ...value, harness });

function publicResult(harness, result) {
  const out = { ...result, harness };
  if (out.sessions) out.sessions = out.sessions.map(item => session(harness, item));
  if (out.candidates) out.candidates = out.candidates.map(item => session(harness, item));
  if (out.session) out.session = session(harness, out.session);
  if (out.fingerprint) out.fingerprint = bound(harness, out.fingerprint);
  if (out.confirmationFingerprint) out.confirmationFingerprint = bound(harness, out.confirmationFingerprint);
  return out;
}

async function invoke(harness, operation, options) {
  try { return await operation(options); }
  catch (error) {
    if (error.details?.preview) error.details = { ...error.details, preview: publicResult(harness, error.details.preview) };
    throw error;
  }
}

export async function listManagedSessions(options = {}) {
  const harness = resolveHarness(options.harness, options.runtimeEnv);
  if (harness !== 'all') return publicResult(harness, await adapters[harness].list(options));
  if (options.root) throw claude.fail('invalid_options', '--root requires one explicit harness');
  const results = await Promise.allSettled(Object.entries(adapters).map(async ([key, adapter]) => publicResult(key, await adapter.list(options))));
  const sessions = [], warnings = []; let unassignedCount = 0, complete = true;
  for (let index = 0; index < results.length; index++) {
    const result = results[index]; const key = Object.keys(adapters)[index];
    if (result.status === 'rejected') { complete = false; warnings.push(`${key}: ${result.reason.message}`); continue; }
    sessions.push(...result.value.sessions); unassignedCount += result.value.unassignedCount || 0;
    complete &&= result.value.complete; warnings.push(...result.value.warnings.map(warning => `${key}: ${warning}`));
  }
  return { harness, ...await claude.resolveScope(options), total: sessions.length, sessions: sessions.sort(claude.byRecentActivity), complete, warnings, unassignedCount };
}

export async function previewManagedDelete(options = {}) {
  const harness = resolveHarness(options.harness, options.runtimeEnv);
  if (harness === 'all') {
    if (options.currentSessionId !== undefined) throw claude.fail('invalid_options', 'Current Session needs one caller harness');
    const listing = await listManagedSessions(options);
    if (!listing.complete) throw claude.fail('incomplete_scan', 'A harness could not be listed; select a supported harness explicitly', { warnings: listing.warnings });
    const candidates = options.id ? listing.sessions.filter(item => item.id.toLowerCase() === options.id.toLowerCase())
      : claude.matchSessions(listing.sessions, options.query).candidates;
    return { status: candidates.length ? 'selection_required' : 'not_found', harness, scope: listing.scope, currentProject: listing.currentProject,
      candidates: candidates.map((item, index) => ({ ...item, number: index + 1 })), reason: 'Choose the harness and full ID, then preview that exact target' };
  }
  const adapter = adapters[harness];
  return publicResult(harness, await invoke(harness, options.currentSessionId !== undefined ? adapter.previewCurrent : adapter.preview, options));
}

export async function executeManagedDelete(options = {}) {
  const harness = resolveHarness(options.harness, options.runtimeEnv);
  if (harness === 'all') throw claude.fail('harness_required', 'Execution requires one selected harness and exact ID');
  const adapter = adapters[harness], current = options.currentSessionId !== undefined;
  if ((!current && !options.id) || !/^[a-f0-9]{64}$/.test(options.expect || '')) throw claude.fail('preview_required', 'Execution needs a selected exact target and its preview fingerprint');
  const preview = await invoke(harness, current ? adapter.previewCurrent : adapter.preview, options);
  if (preview.status !== 'ready') throw claude.fail('not_found', 'Selected target is no longer available');
  const field = current ? 'confirmationFingerprint' : 'fingerprint';
  if (!options.expect || bound(harness, preview[field]) !== options.expect) throw claude.fail('stale_preview', 'Harness, scope, identity or preview changed', { preview: publicResult(harness, preview) });
  return publicResult(harness, await invoke(harness, current ? adapter.executeCurrent : adapter.execute, { ...options, expect: preview[field] }));
}
