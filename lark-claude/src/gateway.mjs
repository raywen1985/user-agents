import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCodexExecutableResolver } from "./codex-executable.mjs";
import {
  collectActiveAgentSessionRecords,
  collectCodexExact,
  listActiveAgentSessions,
  readExactClaudeSession,
  runWindowsSessionProbe,
} from "./active-agent-sessions.mjs";
import { createAgentWorkspaceOverview } from "./agent-workspace-overview.mjs";
import { terminateClaudeProcess } from "./claude-control.mjs";
import { CcSwitchReader } from "./ccswitch-reader.mjs";
import { createCcSwitchSkill } from "./ccswitch-skill.mjs";
import { CodexControlManager } from "./codex-control-client.mjs";
import { loadConfig, projectRoot } from "./config.mjs";
import { ClaudeExecutor } from "./executors/claude.mjs";
import { CodexExecutor } from "./executors/codex.mjs";
import { formatSessionLine, formatSessionMessage } from "./format.mjs";
import { LarkListener, LarkMessenger } from "./lark.mjs";
import { logger } from "./logger.mjs";
import { createInternalSkillRegistry } from "./internal-skills.mjs";
import { ReadApprovalPolicy } from "./read-approval-policy.mjs";
import { buildRouterContext, resolveIntent } from "./resolver.mjs";
import { backfillOverrideAuthorities, revalidateProjectAuthority } from "./project-guard.mjs";
import { ClaudeRouter } from "./router.mjs";
import { Scheduler } from "./scheduler.mjs";
import { findNamedSession, revalidateGatewaySession, revalidateNativeCandidate } from "./session-catalog.mjs";
import { createSessionLookupService, lookupFailureText, resolveCandidateSelection } from "./session-lookup-service.mjs";
import { createStopAgentSession } from "./stop-agent-session.mjs";
import { createStopTargetDecorator } from "./stop-targets.mjs";
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

const store = new Store();
backfillOverrideAuthorities(config, store);
const priorOwner = store.getGatewayInstanceOwner();
if (!priorOwner && fs.existsSync(pidPath)) {
  const oldPid = Number(fs.readFileSync(pidPath, "utf8"));
  if (oldPid && oldPid !== process.pid && processExists(oldPid)) throw new Error(`旧版网关仍在运行，PID=${oldPid}`);
}
if (priorOwner) {
  const priorProbe = await runWindowsSessionProbe({
    locks: [],
    processes: [{ id: "prior", pid: Number(priorOwner.pid), procStart: priorOwner.proc_start }],
  });
  const state = priorProbe.processes.get("prior")?.state;
  if (state === "live" || state === "accessDenied" || state === "error") {
    throw new Error(`网关实例所有权无法安全接管 (${state || "unknown"})`);
  }
}
const selfProbe = await runWindowsSessionProbe({
  locks: [],
  processes: [{ id: "self", pid: process.pid, procStart: "0000000000" }],
});
const selfStart = selfProbe.processes.get("self")?.procStart;
if (!selfStart) throw new Error("无法读取网关进程创建时间");
const ownerEpoch = randomBytes(16).toString("hex");
const recoveryClaims = store.claimGatewayInstance({
  pid: process.pid,
  procStart: selfStart,
  epoch: ownerEpoch,
  expectedOwner: priorOwner,
});
fs.writeFileSync(pidPath, String(process.pid), { flag: "w" });
store.recoverInterrupted();
const messenger = new LarkMessenger({ executable: gateway.executables.larkCli, recipientOpenId: gateway.recipientOpenId });
const listener = new LarkListener({ executable: gateway.executables.larkCli });
const router = new ClaudeRouter({ executable: gateway.executables.claude, model: gateway.routerModel, timeoutMs: gateway.routerTimeoutMs });
const codexExecutable = createCodexExecutableResolver({
  configured: gateway.executables.codex,
  onSelection: ({ executable, source }) => logger.info("Codex 可执行文件已解析", { executable, source }),
});
const readApprovalPolicy = ReadApprovalPolicy.create({ projectRoots: config.projects.map((project) => project.path) });
const codexRoot = path.join(os.homedir(), ".codex");
const claudeRoot = path.join(os.homedir(), ".claude");
const codexControl = new CodexControlManager({
  config: gateway.codexControl,
  resolveExecutable: async () => (await codexExecutable.resolve()).executable,
});
const projectGuard = (session) => revalidateProjectAuthority(session, { config, store, codexRoot });

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
        if (messageId && row.candidate_set_id) store.bindCandidateMessage(messageId, row.candidate_set_id);
      } catch (error) {
        store.markOutboxFailed(row.id);
        logger.error("Outbox 发送失败", { id: row.id, error: error.message });
        break;
      }
    }
  })().finally(() => { flushing = null; });
  return flushing;
}

async function sendGlobal(text, key, options = {}) {
  store.enqueueOutbox(key, `[Gateway | - | - | -]\n${text}`, null, options);
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
      beforeRun: projectGuard,
      beforeResume: (session) => revalidateGatewaySession(session, { config, store, codexRoot, claudeRoot }),
    }),
    codex: new CodexExecutor({
      resolveExecutable: () => codexExecutable.resolve(),
      invalidateExecutable: (executable) => codexExecutable.invalidate(executable),
      timeoutMs: gateway.workerTimeoutMs,
      summaryLength: gateway.summaryLength,
      readApprovalPolicy,
      beforeRun: projectGuard,
      beforeResume: (session) => revalidateGatewaySession(session, { config, store, codexRoot, claudeRoot }),
    }),
  },
  onMessage: sendSession,
});

const recoveredQueuedTasks = store.listQueuedTasks();
for (const recovered of recoveredQueuedTasks) scheduler.enqueue(recovered.task, recovered.session, { defer: true });

const getGatewayActivities = async () => store.enrichActivitySnapshot(
  scheduler.activitySnapshot(Number.MAX_SAFE_INTEGER),
  Number.MAX_SAFE_INTEGER,
);
const exactClaude = (target) => readExactClaudeSession({ claudeRoot, ...target });
const probeClaude = async (target) => {
  const result = await runWindowsSessionProbe({
    locks: [],
    processes: [{ id: target.sessionId, pid: target.pid, procStart: target.procStart }],
  });
  return result.processes.get(target.sessionId)?.state || "error";
};
const exactCodex = ({ threadId }) => collectCodexExact({ codexRoot, threadId });
const decorateStopTargets = createStopTargetDecorator({
  store,
  getGatewayActivities,
  exactClaude,
  probeClaude,
  exactCodex,
  codexControl,
});
const stopAgentSession = createStopAgentSession({
  store,
  scheduler,
  ownerEpoch,
  getGatewayActivities,
  exactClaude,
  probeClaude,
  terminateClaude: terminateClaudeProcess,
  exactCodex,
  codexControl,
});
const ccswitch = createCcSwitchSkill({
  reader: new CcSwitchReader(),
  onDiagnostic: (details) => logger.info("CC Switch 只读查询", details),
});
const inspectAgentWorkspace = createAgentWorkspaceOverview({
  config,
  store,
  codexRoot,
  claudeRoot,
  collectActive: collectActiveAgentSessionRecords,
});

const internalSkills = createInternalSkillRegistry({
  list_active_agent_sessions: async ({ gatewayActivities, gatewayTruncated }) => listActiveAgentSessions({
    gatewayActivities,
    gatewayTruncated,
    codexRoot,
    claudeRoot,
    decorateRecords: decorateStopTargets,
  }),
  inspect_agent_workspace: inspectAgentWorkspace,
  stop_agent_session: stopAgentSession,
  ccswitch,
});

const sessionLookup = createSessionLookupService({
  config,
  store,
  scheduler,
  codexRoot,
  claudeRoot,
  findNamedSession,
  revalidateNativeCandidate,
  sendGlobal,
  sendSession,
});
const { handleNamedLookup, handleNewLookup, handleCandidateReply } = sessionLookup;

for (const claim of recoveryClaims) {
  const operation = store.getStopOperation(claim.operationId);
  if (operation) await stopAgentSession.recover(operation);
}
for (const request of store.listStopRequestsMissingOutbox()) {
  if (["completed", "uncertain"].includes(request.state)) store.repairStopRequestOutbox(request);
}

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
    return sendGlobal("可以自然语言要求 Codex 或 Claude 查找并继续本机历史 Session，或在已发现工程中新建任务；也可以查看、取消、批准/拒绝，查询本机 Agent 项目与 Session 概况，查询或精确停止当前工作的 Agent Session，以及只读查询 CC Switch 的状态、Provider、健康、路由和用量。", `help-${message.message_id}`);
  }
  if (resolved.type === "internal_skill") {
    if (resolved.skillName === "ccswitch") {
      const text = await internalSkills.dispatch("ccswitch", Object.freeze({
        ccswitchAction: resolved.ccswitchAction,
        usagePeriod: resolved.usagePeriod,
      }));
      return sendGlobal(text, `internal-ccswitch-${message.message_id}`);
    }
    if (resolved.skillName === "inspect_agent_workspace") {
      const gatewayActivities = Object.freeze((await getGatewayActivities()).map((record) => Object.freeze(record)));
      const text = await internalSkills.dispatch("inspect_agent_workspace", Object.freeze({
        overviewScope: resolved.overviewScope,
        overviewExecutor: resolved.overviewExecutor,
        projectQuery: resolved.projectQuery,
        sessionQuery: resolved.sessionQuery,
        gatewayActivities,
        gatewayTruncated: false,
      }));
      return sendGlobal(text, `internal-inspect-agent-workspace-${message.message_id}`);
    }
    const snapshot = scheduler.activitySnapshot(201);
    const gatewayTruncated = snapshot.length > 200;
    const gatewayActivities = Object.freeze(store.enrichActivitySnapshot(snapshot.slice(0, 200))
      .map((record) => Object.freeze(record)));
    const result = await internalSkills.dispatch(resolved.skillName, Object.freeze({
      gatewayActivities,
      gatewayTruncated,
      sessionRef: resolved.sessionRef || null,
      messageId: message.message_id,
    }));
    if (resolved.skillName === "stop_agent_session") {
      if (!result.handledByOutbox) return sendGlobal(result.text, `internal-${resolved.skillName}-${message.message_id}`);
      return flushOutbox();
    }
    return sendGlobal(result, `internal-${resolved.skillName}-${message.message_id}`);
  }
  if (resolved.type === "list") {
    const sessions = store.listSessions(gateway.recentSessionLimit);
    const text = sessions.length ? sessions.map(formatSessionLine).join("\n") : "暂无 Session。";
    return sendGlobal(text, `list-${message.message_id}`);
  }
  if (resolved.type === "lookup") return handleNamedLookup(resolved, message);
  if (resolved.type === "lookup_new") return handleNewLookup(resolved, message);
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
    if (resolved.action === "new") {
      const committed = store.commitNamedTask({
        messageId: message.message_id,
        executor: resolved.executor,
        project: resolved.project,
        name: resolved.name,
        content: resolved.content,
        action: "new",
      });
      if (!committed.ok) return sendGlobal(lookupFailureText(committed.reason), `new-commit-${message.message_id}`);
      return sessionLookup.queueCommitted(committed);
    }
    const session = resolved.session;
    let task;
    try {
      task = scheduler.enqueueFactory(session, () => {
        const created = store.createTask({ sessionId: session.id, messageId: message.message_id, action: resolved.action, content: resolved.content });
        store.bindMessage(message.message_id, session.id, "inbound");
        return created;
      }, { defer: true });
    } catch (error) {
      if (error?.code === "SESSION_STOPPING") {
        return sendSession(session, "Session 正在停止，请稍后重试。", `stopping-${message.message_id}`);
      }
      throw error;
    }
    await sendSession(session, "已加入执行队列。", `queued-${task.id}`);
    scheduler.drain();
  }
}

let shuttingDown = false;
async function handleEvent(message) {
  if (shuttingDown) return;
  if (message.chat_type !== "p2p" || message.message_type !== "text") return;
  if (message.sender_type && message.sender_type !== "user") return;
  if (!gateway.allowedOpenIds.includes(message.sender_id)) {
    logger.warn("忽略未授权的飞书发送者", { senderId: message.sender_id });
    return;
  }
  if (!message.message_id || !message.content || !store.acceptInbox(message)) return;
  try {
    const candidateSelection = resolveCandidateSelection(store, message);
    if (candidateSelection.kind === "selected") {
      await handleCandidateReply(candidateSelection.binding, message);
      store.markInbox(message.message_id, "processed");
      return;
    }
    if (candidateSelection.kind === "ambiguous") {
      await sendGlobal("当前聊天有多个有效候选列表，请使用飞书的“回复”功能回复目标候选消息中的编号。", `selection-ambiguous-${message.message_id}`);
      store.markInbox(message.message_id, "processed");
      return;
    }
    const context = buildRouterContext(config, store, message, internalSkills);
    const intent = await router.route(message, context);
    const resolved = resolveIntent(intent, config, store, message, internalSkills);
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
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("网关正在停止", { signal });
  listener.stop();
  if (healthTimer) clearInterval(healthTimer);
  if (outboxTimer) clearInterval(outboxTimer);
  updateHealth({ stopping: true });
  store.markGatewayInstanceDraining(ownerEpoch);
  store.releaseOwnedPendingStops(ownerEpoch);
  const signaling = store.listRecoverableStopOperations().filter((operation) => operation.state === "signaling" && operation.owner_epoch === ownerEpoch);
  await Promise.race([
    Promise.allSettled(signaling.map((operation) => stopAgentSession.recover(operation))),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  for (const request of store.listStopRequestsMissingOutbox()) {
    if (["completed", "uncertain"].includes(request.state)) store.repairStopRequestOutbox(request);
  }
  await flushOutbox();
  store.close();
  try { fs.unlinkSync(pidPath); } catch {}
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("exit", () => { try { if (Number(fs.readFileSync(pidPath, "utf8")) === process.pid) fs.unlinkSync(pidPath); } catch {} });

await listener.start();
if (recoveredQueuedTasks.length) scheduler.drain();
updateHealth({ startedAt: new Date().toISOString() });
healthTimer = setInterval(updateHealth, 15000);
healthTimer.unref?.();
outboxTimer = setInterval(() => flushOutbox().catch((error) => logger.error("Outbox 重试失败", error.message)), 5000);
outboxTimer.unref?.();
await flushOutbox();
logger.info("Lark Agent Gateway 已启动", { pid: process.pid, log: logger.path });
