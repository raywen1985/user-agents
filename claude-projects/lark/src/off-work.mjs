import { inspectOffWork, executeOffWork, formatOffWork } from '../../../skills/session-mgr/scripts/off-work.mjs';
import { logger } from './logger.mjs';

export const OFF_WORK_BUSY = '正在执行下班，当前 Agent 任务将停止；完成后请重新发送新任务。';

export function parseOffWorkCommand(content, messageType = 'text') {
  if (messageType !== 'text') return null;
  const match = /^(?:SessionMgr\s+)?(下班检查|下班)$/i.exec(String(content || '').trim());
  return match ? { type: 'internal_skill', skillName: 'off_work', execute: match[1] === '下班' } : null;
}

export function createOffWorkSkill({ store, scheduler, sendProgress = async () => {},
  inspect = inspectOffWork, execute = executeOffWork, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), waitMs = 6000 }) {
  let running = null;
  return async ({ messageId, execute: requested }) => {
    const options = { protectedPids: [process.pid] };
    if (!requested) return formatOffWork(await inspect(options));
    if (running) return OFF_WORK_BUSY;
    const claim = store.claimOffWork(messageId);
    if (!claim.ownsExecution) return claim.reply_text || '这条下班请求已开始过，但结果未完整保存。为避免再次关闭新会话，请先发送“下班检查”。';
    running = messageId;
    let fence;
    try {
      fence = scheduler.beginOffWork();
      await sendProgress('开始下班：正在停止 Agent 任务并关闭客户端。网关继续运行。', messageId);
      const deadline = Date.now() + waitMs;
      while (scheduler.activitySnapshot(1).length && Date.now() < deadline) await sleep(50);
      const result = await execute(options);
      if (scheduler.activitySnapshot(1).length) {
        result.status = 'partial'; result.released = false;
        result.warnings = [...(result.warnings || []), 'gateway_tasks_still_stopping'];
      }
      const text = formatOffWork(result) + (result.warnings?.includes('gateway_tasks_still_stopping') ? '\n部分网关任务尚未停止，请稍后检查。' : '');
      store.finishOffWork(messageId, result, text);
      logger.info('SessionMgr off-work completed', { messageId, status: result.status, closed: result.outcomes?.length || 0 });
      return text;
    } catch (error) {
      const text = '下班未完成，部分进程可能仍在运行。请发送“下班检查”查看；此消息重试不会再次关闭进程。';
      store.finishOffWork(messageId, { status: 'failed', released: false }, text);
      logger.warn('SessionMgr off-work failed', { messageId, reason: 'shutdown_failed' });
      return text;
    } finally {
      if (fence) scheduler.endOffWork(fence);
      running = null;
    }
  };
}
