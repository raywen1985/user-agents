export { collectSessionList, formatSessionListPages } from '../../../skills/session-mgr/scripts/session-list.mjs';

// Deliberately anchored: mixed work requests must still go through normal
// routing, and notification reply bindings take precedence over this grammar.
export function parseSessionListQuery(content) {
  const text = String(content || '').normalize('NFKC').trim();
  const match = /^(?:请\s*)?(?:列出|列举|查看|查询|显示)\s*(?:(?:当前\s*(?:PC|电脑|本机)|本机|所有项目(?:中|下|的)?)\s*)?(?:(?:所有|全部)\s*)?(claude\s*code|claude|codex|agent)?\s*(?:的\s*)?(?:(?:所有|全部)\s*)?(?:session|会话)(?:\s*列表)?[。！!]?$/i.exec(text);
  if (!match) return null;
  const target = match[1]?.replace(/\s/g, '').toLowerCase();
  return { type: 'internal_skill', skillName: 'list_agent_sessions', overviewExecutor: target === 'codex' ? 'codex' : target?.startsWith('claude') ? 'claude' : null };
}

export function createSessionListHandler({ store, query, flushOutbox }) {
  return async (executor, messageId) => {
    const key = `session-list-${messageId}`;
    if (!store.hasOutboxBatch(key)) {
      const pages = await query(executor);
      store.enqueueOutboxBatch(key, pages.map(text => `[Gateway | - | - | -]\n${text}`));
    }
    await flushOutbox();
  };
}
