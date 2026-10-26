import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import { buildGatewayHealth, processStartFileTimeToIso } from "./gateway-health.mjs";
import { classifyInboundMessage, LarkListener, LarkMessenger } from "./lark.mjs";
import { logger } from "./logger.mjs";
import { createMessageCoordinator } from "./message-coordinator.mjs";
import { createInternalSkillRegistry } from "./internal-skills.mjs";
import { ReadApprovalPolicy } from "./read-approval-policy.mjs";
import { RestartCoordinator } from "./restart-coordinator.mjs";
import { backfillOverrideAuthorities, revalidateProjectAuthority } from "./project-guard.mjs";
import { ClaudeRouter } from "./router.mjs";
import { compactOneLine } from "./sanitize.mjs";
import { Scheduler } from "./scheduler.mjs";
import { findNamedSession, revalidateGatewaySession, revalidateNativeCandidate } from "./session-catalog.mjs";
import { createSessionLookupService, lookupFailureText } from "./session-lookup-service.mjs";
import { createStopAgentSession } from "./stop-agent-session.mjs";
import { createStopTargetDecorator } from "./stop-targets.mjs";
import { Store } from "./store.mjs";
import { parseAudioContent, VoiceTranscriber, voiceFailureText } from "./voice.mjs";

const config = loadConfig();
const { gateway } = config;
const generationIndex = process.argv.indexOf("--installation-generation");
const argumentGeneration = generationIndex >= 0 ? process.argv[generationIndex + 1] : null;
if (generationIndex >= 0 && (!argumentGeneration || !/^[a-f0-9]{32}$/i.test(argumentGeneration))) {
  throw new Error("安装代次参数无效");
}
if (argumentGeneration && gateway.installationGeneration !== argumentGeneration) {
  throw new Error("安装代次与本机配置不一致");
}
const installationGeneration = argumentGeneration || gateway.installationGeneration || null;
const nodeExecutable = fs.realpathSync.native(process.execPath);
const gatewayEntry = fs.realpathSync.native(fileURLToPath(import.meta.url));
const runDirectory = path.join(projectRoot, "run");
const pidPath = path.join(runDirectory, "gateway.pid");
const healthPath = path.join(runDirectory, "health.json");
const restartRequestPath = path.join(runDirectory, "restart-request.json");
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
const processStartedAt = processStartFileTimeToIso(selfStart);
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
const voice = new VoiceTranscriber({
  executable: gateway.executables.larkCli,
  ffmpegExecutable: gateway.executables.ffmpeg,
  engineType: gateway.voice.engineType,
  maxDurationMs: gateway.voice.maxDurationMs,
  maxBytes: gateway.voice.maxBytes,
  timeoutMs: gateway.voice.timeoutMs,
});
const router = new ClaudeRouter({ executable: gateway.executables.claude, model: gateway.routerModel, timeoutMs: gateway.routerTimeoutMs });
const codexExecutable = createCodexExecutableResolver({
  configured: gateway.executables.codex,
  onSelection: ({ executable, source }) => logger.info("Codex 可执行文件已解析", { executable, source }),
});
const readApprovalPolicy = ReadApprovalPolicy.create({
  projectRoots: config.projects.map((project) => project.path),
  svnPath: gateway.executables.svn,
});
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
        store.completeOutboxDelivery(row.id, messageId);
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
  if (!options.prequeued) store.enqueueOutbox(key, `[Gateway | - | - | -]\n${text}`, null, options);
  await flushOutbox();
}

async function sendSession(session, body, key, options = {}) {
  store.enqueueOutbox(key, formatSessionMessage(session, body), session.id, options);
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
      powershellApprovalMode: gateway.powershellApprovalMode,
      beforeRun: projectGuard,
      beforeResume: (session) => revalidateGatewaySession(session, { config, store, codexRoot, claudeRoot }),
    }),
  },
  onMessage: sendSession,
});

const recoveredQueuedTasks = store.listQueuedTasks();
scheduler.reconcileQueuedTasks({ drain: false });

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
const {
  handleNamedLookup,
  handleNewLookup,
  handleUnnamedContinue,
  handleCandidateReply,
  handleCandidateNavigation,
} = sessionLookup;
const messageCoordinator = createMessageCoordinator({ config, store, router, internalSkills });

for (const claim of recoveryClaims) {
  const operation = store.getStopOperation(claim.operationId);
  if (operation) await stopAgentSession.recover(operation);
}
for (const request of store.listStopRequestsMissingOutbox()) {
  if (["completed", "uncertain"].includes(request.state)) store.repairStopRequestOutbox(request);
}

const healthState = {};
const healthIdentity = Object.freeze({
  pid: process.pid,
  procStart: selfStart,
  processStartedAt,
  installationGeneration,
  nodeExecutable,
  gatewayEntry,
});
function updateHealth(extra = {}) {
  Object.assign(healthState, extra);
  fs.writeFileSync(healthPath, JSON.stringify(buildGatewayHealth({
    identity: healthIdentity,
    listenerReady: listener.ready,
    updatedAt: new Date().toISOString(),
    state: healthState,
  }), null, 2));
}

async function handleResolved(resolved, message) {
  if (resolved.type === "reply") return sendGlobal(resolved.text, `reply-${message.message_id}`);
  if (resolved.type === "help" || resolved.type === "unknown") {
    return sendGlobal("可以自然语言要求 Codex 或 Claude 查找并继续本机历史 Session，或在已发现工程中新建任务；也可以查看、取消、批准/拒绝，查询本机 Agent 项目与 Session 概况，查询或精确停止当前工作的 Agent Session，以及只读查询 CC Switch 的状态、Provider、健康、路由和用量。也可以直接发送语音消息，网关会自动转写后执行。", `help-${message.message_id}`);
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
  if (resolved.type === "lookup_unnamed") return handleUnnamedContinue(resolved, message);
  if (resolved.type === "candidate_reply") return handleCandidateReply(resolved.binding, message);
  if (resolved.type === "candidate_navigation") {
    return handleCandidateNavigation(resolved.binding, message, resolved.direction);
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
  if (resolved.type === "approve_scope") {
    const result = scheduler.resolveApprovalGrant(resolved.approval.id, resolved.mode);
    if (!result.ok) {
      return sendGlobal("该审批请求已失效或不支持任务级授权，请重新处理最新审批消息。", `approval-scope-stale-${message.message_id}`);
    }
    const scope = resolved.mode === "class" ? `同类操作（${result.operationClass}）` : "当前 Task 内所有可授权操作";
    const suffix = result.remaining > 0 ? `\n仍有 ${result.remaining} 个不可授权请求需要单独确认。` : "";
    return sendSession(result.session,
      `已授权${scope}，当前批准 ${result.approved} 个请求；后续符合条件的请求将自动批准。${suffix}`,
      `approval-scope-${message.message_id}`);
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
        approvalProfile: resolved.approvalProfile,
      });
      if (!committed.ok) return sendGlobal(lookupFailureText(committed.reason), `new-commit-${message.message_id}`);
      return sessionLookup.queueCommitted(committed);
    }
    const session = resolved.session;
    if (!scheduler.canEnqueue(session.id)) {
      return sendSession(session, "Session 正在停止，请稍后重试。", `stopping-${message.message_id}`);
    }
    const authority = store.getProjectAuthority(session.id);
    const committed = store.commitNamedTask({
      messageId: message.message_id,
      candidate: {
        gatewayId: session.id,
        executor: session.executor,
        authority: authority ? {
          sourceType: authority.source_type,
          provider: authority.provider,
          nativeId: authority.native_id,
          sourcePath: authority.source_path,
          overrideAlias: authority.override_alias,
        } : null,
      },
      executor: session.executor,
      project: {
        alias: session.project_alias,
        path: session.project_path,
        authorities: [],
      },
      name: session.name,
      content: resolved.content,
      action: resolved.action,
      approvalProfile: resolved.approvalProfile,
    });
    if (!committed.ok) return sendGlobal(lookupFailureText(committed.reason), `continue-commit-${message.message_id}`);
    return sessionLookup.queueCommitted(committed);
  }
}

let shuttingDown = false;
function canAcceptInbound(message) {
  if (message.chat_type !== "p2p") return false;
  const inboundType = classifyInboundMessage(message.message_type, message.content);
  if (inboundType === "unsupported") return false;
  if (message.sender_type && message.sender_type !== "user") return false;
  if (!gateway.allowedOpenIds.includes(message.sender_id)) {
    logger.warn("忽略未授权的飞书发送者", { senderId: message.sender_id });
    return false;
  }
  return !(!gateway.voice.enabled && inboundType === "audio") && Boolean(message.message_id && message.content);
}

function persistFencedMessage(message) {
  if (!canAcceptInbound(message)) return false;
  return store.acceptInbox(message);
}

async function handleEvent(message, { replay = false } = {}) {
  if (shuttingDown) return;
  if (!canAcceptInbound(message)) return;
  const inboundType = classifyInboundMessage(message.message_type, message.content);
  if (!replay && !store.acceptInbox(message)) return;
  if (inboundType === "post_resource") {
    try {
      await sendGlobal("此条富文本消息包含图片或附件，无法作为远程指令处理；请改发纯文本消息。", `post-resource-${message.message_id}`);
      store.markInbox(message.message_id, "processed");
    } catch (error) {
      store.markInbox(message.message_id, "failed");
      throw error;
    }
    return;
  }
  if (inboundType === "audio") {
    const audio = parseAudioContent(message.content);
    if (!audio) {
      store.markInbox(message.message_id, "failed");
      await sendGlobal("语音消息无法解析，请改用文字。", `voice-invalid-${message.message_id}`);
      return;
    }
    let transcript;
    try {
      transcript = await voice.transcribe({ messageId: message.message_id, ...audio });
    } catch (error) {
      store.markInbox(message.message_id, "failed");
      logger.warn("语音消息识别失败", { messageId: message.message_id, code: error.code || "VOICE_RECOGNITION_FAILED" });
      await sendGlobal(voiceFailureText(error), `voice-error-${message.message_id}`);
      return;
    }
    message = { ...message, content: transcript };
    if (gateway.voice.echoTranscript) {
      await sendGlobal(`语音已转文字：${compactOneLine(transcript, 300)}`, `voice-transcript-${message.message_id}`);
    }
  }
  try {
    const resolved = await messageCoordinator.coordinate(message);
    await handleResolved(resolved, message);
    store.markInbox(message.message_id, "processed");
  } catch (error) {
    store.markInbox(message.message_id, "failed");
    logger.error("处理飞书消息失败", { messageId: message.message_id, error: error.message });
    await sendGlobal(`处理失败：${error.message}`, `error-${message.message_id}`);
  }
}

async function replayPendingInbox() {
  for (const pending of store.listPendingInbox()) {
    await handleEvent({ ...pending, chat_type: "p2p", sender_type: "user" }, { replay: true });
  }
}

let healthTimer;
let outboxTimer;
let queueTimer;
let restartTimer;
async function shutdown(signal, health = {}) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("网关正在停止", { signal });
  await listener.stop().catch((error) => logger.warn("飞书事件监听停止失败", error.message));
  if (healthTimer) clearInterval(healthTimer);
  if (outboxTimer) clearInterval(outboxTimer);
  if (queueTimer) clearInterval(queueTimer);
  if (restartTimer) clearInterval(restartTimer);
  updateHealth({ stopping: true, ...health });
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

const restartCoordinator = new RestartCoordinator({
  markerPath: restartRequestPath,
  listener,
  scheduler,
  store,
  handleMessage: handleEvent,
  persistFencedMessage,
  replayPending: replayPendingInbox,
  updateHealth,
  onRestartReady: () => shutdown("restart", { restartReady: true }),
});

listener.on("event", (message) => {
  restartCoordinator.dispatch(message).catch((error) => logger.error("事件处理异常", error.message));
});
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("exit", () => { try { if (Number(fs.readFileSync(pidPath, "utf8")) === process.pid) fs.unlinkSync(pidPath); } catch {} });

await listener.start();
await replayPendingInbox();
if (recoveredQueuedTasks.length) scheduler.drain();
updateHealth({
  startedAt: new Date().toISOString(), stopping: false,
  restartReady: false, restartDeferred: false, restartError: null, restartRequestedAt: null,
});
healthTimer = setInterval(updateHealth, 15000);
healthTimer.unref?.();
outboxTimer = setInterval(() => flushOutbox().catch((error) => logger.error("Outbox 重试失败", error.message)), 5000);
outboxTimer.unref?.();
queueTimer = setInterval(() => {
  try { scheduler.reconcileQueuedTasks(); } catch (error) {
    logger.error("持久化队列对账失败", { error: error.message });
  }
}, 15000);
queueTimer.unref?.();
restartTimer = setInterval(() => {
  restartCoordinator.check().catch((error) => logger.error("Gateway 重启协调失败", error.message));
}, 1000);
restartTimer.unref?.();
await flushOutbox();
logger.info("Lark Agent Gateway 已启动", { pid: process.pid, log: logger.path });
