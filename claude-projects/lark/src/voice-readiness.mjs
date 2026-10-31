import { runProcess } from './process-utils.mjs';
import { loadChildEnvironment } from './config.mjs';

export function parseSpeechPermission(result) {
  try {
    const payload = JSON.parse(result.stdout || '');
    if (result.code !== 0 || payload.ok !== true || payload.identity !== 'bot' || !Array.isArray(payload.data?.scopes)) return 'unknown';
    return payload.data.scopes.some(item => item.scope_name === 'speech_to_text:speech'
      && item.scope_type !== 'user' && item.grant_status === 1) ? 'granted' : 'missing';
  } catch { return 'unknown'; }
}

export function createVoiceReadiness({ executable, run = runProcess, now = Date.now, ttlMs = 60000 } = {}) {
  let state = { permission: 'unknown', recognition: 'untested', checkedAt: null, lastError: null }, pending = null;
  const snapshot = () => ({ ...state });
  return {
    snapshot,
    async check() {
      if (state.checkedAt && now() - Date.parse(state.checkedAt) < ttlMs) return snapshot();
      if (!pending) pending = (async () => {
        let permission = 'unknown';
        try {
          permission = parseSpeechPermission(await run(executable, ['api', 'GET', '/open-apis/application/v6/scopes', '--as', 'bot'], {
            env: loadChildEnvironment(), timeoutMs: 5000, maxOutputBytes: 1024 * 1024,
          }));
        } catch {}
        state = { ...state, permission, checkedAt: new Date(now()).toISOString() };
        return snapshot();
      })().finally(() => { pending = null; });
      return pending;
    },
    record(code, upstreamCode = null) {
      state = { ...state, recognition: code === 'ok' ? 'available' : code === 'VOICE_RATE_LIMITED' ? 'rate_limited'
        : code === 'VOICE_SERVICE_UNAVAILABLE' ? 'service_unavailable' : 'error',
      lastError: code === 'ok' ? null : code, upstreamCode };
    },
  };
}
