import fs from "node:fs";
import path from "node:path";
import { createCodexExecutableResolver } from "./codex-executable.mjs";
import { loadConfig, projectRoot } from "./config.mjs";
import { ClaudeExecutor } from "./executors/claude.mjs";
import { CodexExecutor } from "./executors/codex.mjs";
import { formatSessionLine, formatSessionMessage } from "./format.mjs";
import { LarkListener, LarkMessenger } from "./lark.mjs";
import { logger } from "./logger.mjs";
import { buildRouterContext, resolveIntent } from "./resolver.mjs";
import { ClaudeRouter } from "./router.mjs";
import { Scheduler } from "./scheduler.mjs";
import { Store } from "./store.mjs";

const config = loadConfig();
const { gateway } = config;
const runDirectory = path.join(projectRoot, "run");
const pidPath = path.join(runDirectory, "gateway.pid");
const healthPath = path.join(runDirectory, "health.json");
fs.mkdirSync(runDirectory, { recursive: true });

function processExists(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

if (fs.existsSync(pidPath)) {
  const oldPid = Number(fs.readFileSync(pidPath, "utf8"));
  if (oldPid && oldPid !== process.pid && processExists(oldPid)) throw new Error(`网关已在运行，PID=${oldPid}`);
}
fs.writeFileSync(pidPath, String(process.pid), { flag: "w" });

const store = new Store();
store.recoverInterrupted();
const messenger = new LarkMessenger({ executable: gateway.executables.larkCli, recipientOpenId: gateway.recipientOpenId });
const listener = new LarkListener({ executable: gateway.executables.larkCli });
const router = new ClaudeRouter({ executable: gateway.executables.claude, model: gateway.routerModel, timeoutMs: gateway.routerTimeoutMs });
const codexExecutable = createCodexExecutableResolver({
  configured: gateway.executables.codex,
  onSelection: ({ executable, source }) => logger.info("Codex 可执行文件已解析", { executable, source }),
});

let flushing = null;
async function flushOutbox() {
  if (flushing) return flushing;
  flushing = (async () => {
    let row;
    while ((row = store.nextOutbox())) {
      try {
        const messageId = await messenger.sendText(row.text, `lark-gateway-${row.id}`);
        store.markOutboxSent(row.id, messageId);
        if (messageId && row.session_id) store.bindMessage(messageId, row.session_id, "outbound");
      } catch (error) {
        store.markOutboxFailed(row.id);
        logger.error("Outbox 发送失败", { id: row.id, error: error.message });
        break;
      }
    }
  })().finally(() => { flushing = null; });
  return flushing;
}

async function sendGlobal(text, key) {
  store.enqueueOutbox(key, `[Gateway | - | - | -]\n${text}`);
  await flushOutbox();
}

async function sendSession(session, body, key) {
  store.enqueueOutbox(key, formatSessionMessage(session, body), session.id);
  await flushOutbox();
}

const scheduler = new Scheduler({
  store,
  maxConcurrentProjects: gateway.maxConcurrentProjects,
  executors: {
    claude: new ClaudeExecutor({
      executable: gateway.executables.claude,
      model: gateway.workerModel,
      timeoutMs: gateway.workerTimeoutMs,
      summaryLength: gateway.summaryLength,
    }),
    codex: new CodexExecutor({
      resolveExecutable: () => codexExecutable.resolve(),
      invalidateExecutable: (executable) => codexExecutable.invalidate(executable),
      timeoutMs: gateway.workerTimeoutMs,
      summaryLength: gateway.summaryLength,
    }),
  },
  onMessage: sendSession,
});

function updateHealth(extra = {}) {
  fs.writeFileSync(healthPath, JSON.stringify({
    pid: process.pid,
    listenerReady: listener.ready,
    updatedAt: new Date().toISOString(),
    ...extra,
  }, null, 2));
}

async function handleResolved(resolved, message) {
  if (resolved.type === "reply") return sendGlobal(resolved.text, `reply-${message.message_id}`);
  if (resolved.type === "help" || resolved.type === "unknown") {
    return sendGlobal("可以自然语言要求 Codex 或 Claude 在已登记项目中新建任务，也可以继续、查看、取消现有 Session，或批准/拒绝待确认请求。", `help-${message.message_id}`);
  }
  if (resolved.type === "list") {
    const sessions = store.listSessions(gateway.recentSessionLimit);
    const text = sessions.length ? sessions.map(formatSessionLine).join("\n") : "暂无 Session。";
    return sendGlobal(text, `list-${message.message_id}`);
  }
  if (resolved.type === "status") {
    const task = store.latestTaskForSession(resolved.session.id);
    const details = task ? `状态：${resolved.session.status}\n最近任务：${task.status}\n${resolved.session.last_summary || "暂无摘要"}` : `状态：${resolved.session.status}`;
    return sendSession(resolved.session, details, `status-${message.message_id}`);
  }
  if (resolved.type === "cancel") {
    const cancelled = scheduler.cancel(resolved.session.id);
    return sendSession(resolved.session, cancelled ? "已请求取消。" : "当前没有可取消的运行任务。", `cancel-request-${message.message_id}`);
  }
  if (resolved.type === "approve" || resolved.type === "reject") {
    const accepted = resolved.type === "approve";
    const delivered = scheduler.resolveApproval(resolved.approval.id, accepted);
    if (!delivered) return sendGlobal(`请求 ${resolved.approval.id} 已不在当前运行进程中，未执行。`, `approval-stale-${message.message_id}`);
    store.resolveApproval(resolved.approval.id, accepted ? "approved" : "rejected");
    const session = store.getSession(resolved.approval.session_id);
    store.updateSession(session.id, { status: "running" });
    return sendSession(session, `${accepted ? "已批准" : "已拒绝"}请求 ${resolved.approval.id}。`, `approval-result-${message.message_id}`);
  }
  if (resolved.type === "enqueue") {
    let session = resolved.session;
    if (resolved.action === "new") {
      session = store.createSession({
        executor: resolved.executor,
        projectAlias: resolved.project.alias,
        projectPath: resolved.project.path,
        name: resolved.name,
      });
    }
    const task = store.createTask({ sessionId: session.id, messageId: message.message_id, action: resolved.action, content: resolved.content });
    store.bindMessage(message.message_id, session.id, "inbound");
    await sendSession(session, "已加入执行队列。", `queued-${task.id}`);
    scheduler.enqueue(task, session);
  }
}

async function handleEvent(message) {
  if (message.chat_type !== "p2p" || message.message_type !== "text") return;
  if (message.sender_type && message.sender_type !== "user") return;
  if (!gateway.allowedOpenIds.includes(message.sender_id)) {
    logger.warn("忽略未授权的飞书发送者", { senderId: message.sender_id });
    return;
  }
  if (!message.message_id || !message.content || !store.acceptInbox(message)) return;
  try {
    const context = buildRouterContext(config, store, message);
    const intent = await router.route(message, context);
    const resolved = resolveIntent(intent, config, store, message);
    await handleResolved(resolved, message);
    store.markInbox(message.message_id, "processed");
  } catch (error) {
    store.markInbox(message.message_id, "failed");
    logger.error("处理飞书消息失败", { messageId: message.message_id, error: error.message });
    await sendGlobal(`处理失败：${error.message}`, `error-${message.message_id}`);
  }
}

listener.on("event", (message) => { handleEvent(message).catch((error) => logger.error("事件处理异常", error.message)); });

let healthTimer;
let outboxTimer;
async function shutdown(signal) {
  logger.info("网关正在停止", { signal });
  listener.stop();
  if (healthTimer) clearInterval(healthTimer);
  if (outboxTimer) clearInterval(outboxTimer);
  updateHealth({ stopping: true });
  store.close();
  try { fs.unlinkSync(pidPath); } catch {}
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("exit", () => { try { if (Number(fs.readFileSync(pidPath, "utf8")) === process.pid) fs.unlinkSync(pidPath); } catch {} });

await listener.start();
updateHealth({ startedAt: new Date().toISOString() });
healthTimer = setInterval(updateHealth, 15000);
healthTimer.unref?.();
outboxTimer = setInterval(() => flushOutbox().catch((error) => logger.error("Outbox 重试失败", error.message)), 5000);
outboxTimer.unref?.();
await flushOutbox();
logger.info("Lark Agent Gateway 已启动", { pid: process.pid, log: logger.path });
