import { createHash } from 'node:crypto';
import { executeDelete, fail, previewDelete } from './session-store.mjs';
import { resolveCurrentRuntime } from './current-runtime.mjs';

async function currentTarget(options) {
  if (options.id !== undefined || options.query !== undefined) {
    throw fail('invalid_options', '--current-session cannot be combined with --id or --query');
  }
  const id = options.currentSessionId;
  if (id !== 'auto' && (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) {
    throw fail('current_session_unavailable', 'Use --current-session auto or a complete expected UUID; do not guess a target');
  }
  const currentIdentity = await resolveCurrentRuntime(options);
  if (id !== 'auto' && id.toLowerCase() !== currentIdentity.id) {
    throw fail('current_session_mismatch', 'Requested Session is not the current runtime Session; preview the current target and confirm again', {
      requestedId: id.toLowerCase(), currentId: currentIdentity.id,
    });
  }
  return { ...options, id: currentIdentity.id, currentIdentity };
}

export async function previewCurrentSessionDelete(options = {}) {
  const target = await currentTarget(options);
  const plan = await previewDelete(target);
  if (plan.status !== 'ready') return { ...plan, currentSession: true };
  // The confirmation reply and subsequent tool call append to this transcript.
  // Bind consent to the target, scope and observed process identities; execution
  // still obtains and checks a fresh content fingerprint inside one invocation.
  const owners = plan.session.activity.owners.map(({ pid, procStart, state }) => ({ pid, procStart, state }))
    .sort((a, b) => a.pid - b.pid || String(a.procStart).localeCompare(String(b.procStart)));
  const confirmationFingerprint = createHash('sha256').update(JSON.stringify({
    mode: 'current-session', root: plan.root, scope: plan.scope, currentProject: plan.currentProject,
    id: plan.session.id, activity: plan.session.activity.state, owners, currentIdentity: target.currentIdentity,
  })).digest('hex');
  return { ...plan, currentSession: true, currentIdentity: target.currentIdentity, confirmationFingerprint, requiresConfirmation: 'active' };
}

export async function executeCurrentSessionDelete(options = {}) {
  const target = await currentTarget(options);
  if (!/^[a-f0-9]{64}$/.test(options.expect || '')) {
    throw fail('preview_required', 'Current Session execution requires --expect confirmationFingerprint from a preview');
  }
  // A verified caller invoking its own deletion is live. A catalog scan must
  // never skip the separate active confirmation for this operation.
  if (!options.allowActive) {
    throw fail('active_confirmation_required', 'Deleting the current Session requires a separate user confirmation and --allow-active');
  }
  const plan = await previewCurrentSessionDelete(options);
  if (plan.status !== 'ready') throw fail('not_found', 'Current Session was not found in the selected scope');
  if (plan.confirmationFingerprint !== options.expect) {
    throw fail('stale_preview', 'Current Session identity, scope or activity changed; preview and confirm again', { preview: plan });
  }
  const result = await executeDelete({ ...target, expect: plan.fingerprint, verifyCurrentSession: async () => {
    const now = await resolveCurrentRuntime(options);
    if (JSON.stringify(now) !== JSON.stringify(plan.currentIdentity)) {
      throw fail('current_session_mismatch', 'Current runtime changed before deletion; preview and confirm the new target');
    }
  } });
  return { ...result, currentSession: true, runtimeStillActive: true };
}
