import { logger } from './logger.mjs';

export async function retrySnapshot(read, { sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const result = await read();
  if (result?.complete !== false && !(result?.ok === false && result.reason === 'snapshot_incomplete')) return result;
  await sleep(250);
  return read();
}

const REASONS = new Set(['busy', 'archived', 'native_missing', 'project_unverified', 'project_excluded',
  'identity_conflict', 'snapshot_incomplete', 'stale_target', 'name_claim_conflict', 'name_in_use',
  'selection_expired', 'selection_superseded', 'missing_project', 'invalid_name', 'target_mismatch', 'stopping', 'off_work']);
export function logLookupFailure({ messageId, reason, executor }, log = logger) {
  log.warn('Session lookup failed', {
    messageId: String(messageId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 160),
    reason: REASONS.has(reason) ? reason : 'lookup_failed',
    executor: ['codex', 'claude'].includes(executor) ? executor : null,
  });
}

export function candidateFailure(candidate) {
  if (['archived', 'native_missing'].includes(candidate?.capability)) return candidate.capability;
  return candidate?.busy ? 'busy' : candidate?.capability;
}
