import { randomBytes } from "node:crypto";

const PUBLIC_OUTCOMES = Object.freeze({
  stopped: "Session 已停止。",
  invalid_session_ref: "停止ID无效，请重新查询活动 Agent Session。",
  expired_session_ref: "停止ID已过期，请重新查询活动 Agent Session。",
  not_active: "未找到活动 Session。",
  already_finished: "目标任务已自然结束，未执行停止。",
  stale_target: "停止目标已变化，请重新查询活动 Agent Session。",
  completion_race: "目标在停止确认前以其他状态结束。",
  ambiguous_control_owner: "目标存在多个控制 owner，未执行停止。",
  control_unreachable: "目标控制通道不可达，未执行停止。",
  control_incompatible: "当前 Codex 控制通道不兼容精确停止。",
  identity_changed: "目标进程身份已变化，未执行停止。",
  snapshot_incomplete: "无法完整验证停止目标，请重新查询。",
  stop_timeout: "精确停止请求超时，未确认成功。",
  stop_in_progress: "同一目标正在停止处理中，未发送第二次停止信号。",
  uncertain: "无法确认停止信号是否导致目标结束。",
  provider_error: "停止目标时发生受控的 provider 错误。",
});

function globalReply(target, outcome, stopRef = "{STOP_REF}") {
  const agent = target?.agent === "claude" ? "Claude" : "Codex";
  const sessionId = target?.sessionId || "-";
  return `[Gateway | - | - | -]\nAgent: ${agent}\nSession: ${sessionId}\n停止ID: ${stopRef}\n${PUBLIC_OUTCOMES[outcome] || PUBLIC_OUTCOMES.provider_error}`;
}

function directReply(outcome, stopRef) {
  return `停止ID: ${stopRef || "-"}\n${PUBLIC_OUTCOMES[outcome] || PUBLIC_OUTCOMES.provider_error}`;
}

function sorted(values) {
  return [...new Set((values || []).map(String).filter(Boolean))].sort();
}

function sameSet(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function createStopAgentSession({
  store,
  scheduler,
  ownerEpoch,
  getGatewayActivities,
  exactClaude,
  probeClaude,
  terminateClaude,
  exactCodex,
  codexControl,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  contenderWaitMs = 10000,
}) {
  const terminalize = (operation, target, outcome, state = "completed", releaseActiveKey = false) => store.terminalizeStopOperation({
    operationId: operation.id,
    ownerEpoch,
    ownerToken: operation.owner_token,
    state,
    outcome,
    replyText: globalReply(target, outcome),
    releaseActiveKey,
  });

  async function waitForShared(operationId, messageId, stopRef) {
    const deadline = Date.now() + contenderWaitMs;
    while (Date.now() <= deadline) {
      const operation = store.getStopOperation(operationId);
      if (operation?.state === "completed" || operation?.state === "uncertain") return { handledByOutbox: true };
      await sleep(100);
    }
    store.enqueueStopRequestReply(messageId, `[Gateway | - | - | -]\n${directReply("stop_in_progress", stopRef)}`);
    return { handledByOutbox: true };
  }

  async function revalidateGateway(target) {
    let activities;
    try { activities = await getGatewayActivities(); } catch { return { ok: false, outcome: "snapshot_incomplete" }; }
    if (!Array.isArray(activities)) return { ok: false, outcome: "snapshot_incomplete" };
    const matches = activities.filter((candidate) => target.nativeId
      ? candidate.agent === target.agent && candidate.nativeId === target.nativeId
      : (candidate.gatewayId || candidate.sessionId) === target.gatewayId);
    const owners = [...new Set(matches.map((candidate) => candidate.gatewayId || candidate.sessionId).filter(Boolean))].sort();
    if (owners.length > 1) return { ok: false, outcome: "ambiguous_control_owner" };
    if (owners.length !== 1 || owners[0] !== target.gatewayId) return { ok: false, outcome: "stale_target" };
    const taskIds = sorted(matches.map((candidate) => candidate.taskId));
    return sameSet(taskIds, target.taskIds) ? { ok: true } : { ok: false, outcome: "stale_target" };
  }

  async function waitGatewayCancelled(target) {
    const deadline = Date.now() + 5000;
    while (Date.now() <= deadline) {
      const activeIds = new Set(scheduler.exactActivity(target.gatewayId).map((row) => row.taskId));
      const tasks = store.getTasksByIds(target.taskIds);
      if (tasks.length === target.taskIds.length
        && target.taskIds.every((taskId) => !activeIds.has(taskId))
        && tasks.every((task) => task.status === "cancelled")) return true;
      await sleep(50);
    }
    return false;
  }

  async function executeGateway(operation, target) {
    const validated = await revalidateGateway(target);
    if (!validated.ok) return terminalize(operation, target, validated.outcome, "completed", true);
    const prepared = scheduler.prepareCancel(target.gatewayId, target.taskIds);
    if (!prepared.ok) return terminalize(operation, target, prepared.reason, "completed", true);
    try {
      if (!store.markStopSignaling(operation.id, ownerEpoch, operation.owner_token)) throw new Error("Stop operation ownership changed");
      const committed = scheduler.commitCancel(prepared.plan);
      if (!committed.ok) return terminalize({ ...operation, state: "signaling" }, target, committed.reason, "uncertain", false);
      if (await waitGatewayCancelled(target)) return terminalize({ ...operation, state: "signaling" }, target, "stopped");
      return terminalize({ ...operation, state: "signaling" }, target, "stop_timeout", "uncertain");
    } finally {
      scheduler.releaseCancel(prepared.plan);
    }
  }

  async function executeClaude(operation, target) {
    const exact = await exactClaude(target);
    if (!exact.ok) return terminalize(operation, target, exact.reason || "identity_changed", "completed", true);
    const processState = await probeClaude(target);
    if (processState !== "live") {
      const outcome = processState === "reused" ? "identity_changed" : processState === "exited" ? "already_finished" : "provider_error";
      return terminalize(operation, target, outcome, "completed", true);
    }
    if (!store.markStopSignaling(operation.id, ownerEpoch, operation.owner_token)) throw new Error("Stop operation ownership changed");
    const result = await terminateClaude(target);
    const outcome = {
      terminated: "stopped",
      alreadyExited: "already_finished",
      reused: "identity_changed",
      accessDenied: "provider_error",
      timeout: "stop_timeout",
      error: "provider_error",
    }[result.state] || "provider_error";
    return terminalize({ ...operation, state: "signaling" }, target, outcome,
      outcome === "stopped" || outcome === "already_finished" ? "completed" : "uncertain");
  }

  async function executeCodex(operation, target) {
    const exact = await exactCodex({ threadId: target.sessionId });
    if (!exact || exact.turnId !== target.turnId || exact.status !== "inProgress") {
      return terminalize(operation, target, "already_finished", "completed", true);
    }
    const owner = await codexControl.probeExactOwner({ threadId: target.sessionId, turnId: target.turnId });
    if (!owner.ready) return terminalize(operation, target, owner.reason || "control_unreachable", "completed", true);
    owner.connection?.close?.();
    if (owner.endpointId !== target.endpointId) return terminalize(operation, target, "stale_target", "completed", true);
    if (!store.markStopSignaling(operation.id, ownerEpoch, operation.owner_token)) throw new Error("Stop operation ownership changed");
    const result = await codexControl.interruptExact({
      endpointId: target.endpointId, threadId: target.sessionId, turnId: target.turnId,
    });
    return terminalize({ ...operation, state: "signaling" }, target, result.outcome,
      result.ok ? "completed" : ["completion_race", "already_finished"].includes(result.outcome) ? "completed" : "uncertain");
  }

  const stopAgentSession = async function stopAgentSession({ sessionRef, messageId }) {
    const ownerToken = randomBytes(16).toString("hex");
    const claim = store.claimStopOperation({ stopRef: sessionRef, messageId, ownerEpoch, ownerToken });
    if (["invalid_session_ref", "expired_session_ref"].includes(claim.status)) {
      return { handledByOutbox: false, text: directReply(claim.status, sessionRef) };
    }
    if (claim.status === "terminal") return { handledByOutbox: true };
    if (!claim.ownsExecution) return waitForShared(claim.operation.id, messageId, sessionRef);
    try {
      if (claim.target.provider === "gateway") await executeGateway(claim.operation, claim.target);
      else if (claim.target.provider === "claude") await executeClaude(claim.operation, claim.target);
      else await executeCodex(claim.operation, claim.target);
      return { handledByOutbox: true };
    } catch {
      const current = store.getStopOperation(claim.operation.id);
      if (current?.state === "signaling") {
        await stopAgentSession.recover(current);
        return { handledByOutbox: true };
      }
      const failure = store.failStopAttempt({
        operationId: claim.operation.id,
        ownerEpoch,
        ownerToken: claim.operation.owner_token,
        outcome: "provider_error",
        replyText: globalReply(claim.target, "provider_error"),
      });
      if (failure.status === "released") return stopAgentSession({ sessionRef, messageId });
      if (failure.status === "lost") return waitForShared(claim.operation.id, messageId, sessionRef);
      return { handledByOutbox: true };
    }
  };

  stopAgentSession.recover = async (operation) => {
    const current = store.getStopOperation(operation.id);
    if (!current || !["pending", "signaling"].includes(current.state)
      || current.owner_epoch !== ownerEpoch || !current.owner_token) return false;
    const target = current.target;
    try {
      if (current.state === "pending") {
        if (target.provider === "gateway") await executeGateway(current, target);
        else if (target.provider === "claude") await executeClaude(current, target);
        else await executeCodex(current, target);
        return true;
      }
      if (target.provider === "gateway") {
        const tasks = store.getTasksByIds(target.taskIds);
        if (tasks.length === target.taskIds.length && tasks.every((task) => task.status === "cancelled")) {
          terminalize(current, target, "stopped");
          return true;
        }
        const activeIds = sorted(scheduler.exactActivity(target.gatewayId).map((row) => row.taskId));
        if (sameSet(activeIds, target.taskIds)) {
          const prepared = scheduler.prepareCancel(target.gatewayId, target.taskIds);
          if (prepared.ok) {
            try {
              const result = scheduler.commitCancel(prepared.plan);
              if (result.ok && await waitGatewayCancelled(target)) terminalize(current, target, "stopped");
              else terminalize(current, target, result.ok ? "stop_timeout" : "uncertain", "uncertain");
            } finally { scheduler.releaseCancel(prepared.plan); }
            return true;
          }
        }
        const naturallyFinished = tasks.length === target.taskIds.length
          && tasks.every((task) => ["completed", "failed"].includes(task.status));
        terminalize(current, target, naturallyFinished ? "already_finished" : "uncertain", naturallyFinished ? "completed" : "uncertain");
        return true;
      }
      if (target.provider === "claude") {
        const processState = await probeClaude(target);
        if (processState !== "live") {
          terminalize(current, target, "uncertain", "uncertain");
          return true;
        }
        const result = await terminateClaude(target);
        terminalize(current, target, result.state === "terminated" ? "stopped" : "uncertain",
          result.state === "terminated" ? "completed" : "uncertain");
        return true;
      }
      const exact = await exactCodex({ threadId: target.sessionId });
      if (exact?.turnId === target.turnId && exact.status === "interrupted") {
        terminalize(current, target, "stopped");
        return true;
      }
      if (exact?.turnId === target.turnId && exact.status === "inProgress") {
        const result = await codexControl.interruptExact({
          endpointId: target.endpointId, threadId: target.sessionId, turnId: target.turnId,
        });
        terminalize(current, target, result.outcome, result.ok ? "completed" : "uncertain");
        return true;
      }
      terminalize(current, target, "completion_race", "completed");
      return true;
    } catch {
      terminalize(current, target, "uncertain", "uncertain");
      return true;
    }
  };

  return stopAgentSession;
}

export { PUBLIC_OUTCOMES };
