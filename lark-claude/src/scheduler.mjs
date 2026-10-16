import { randomBytes } from "node:crypto";
import { formatError, formatSessionMessage } from "./format.mjs";
import { logger } from "./logger.mjs";
import { projectPathsConflict } from "./project-policy.mjs";

function sortedUnique(values) {
  return [...new Set(values.map(String).filter(Boolean))].sort();
}

function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export class Scheduler {
  constructor({ store, executors, onMessage, maxConcurrentProjects = 2 }) {
    this.store = store;
    this.executors = executors;
    this.onMessage = onMessage;
    this.maxConcurrentProjects = maxConcurrentProjects;
    this.queue = [];
    this.runningProjects = new Set();
    this.active = new Map();
    this.approvalWaiters = new Map();
    this.cancelFences = new Map();
    this.cancelPlans = new Map();
    this.knownTaskIds = new Set();
  }

  enqueue(task, session, { defer = false } = {}) {
    if (this.cancelFences.has(session.id)) {
      const error = new Error("Session 正在停止，请稍后重试。");
      error.code = "SESSION_STOPPING";
      throw error;
    }
    if (this.knownTaskIds.has(task.id)) return false;
    this.knownTaskIds.add(task.id);
    this.queue.push({ task, session });
    if (!defer) this.#drain();
    return true;
  }

  enqueueFactory(session, createTask, { defer = false } = {}) {
    if (this.cancelFences.has(session.id)) {
      const error = new Error("Session 正在停止，请稍后重试。");
      error.code = "SESSION_STOPPING";
      throw error;
    }
    const task = createTask();
    if (this.knownTaskIds.has(task.id)) return task;
    this.knownTaskIds.add(task.id);
    this.queue.push({ task, session });
    if (!defer) this.#drain();
    return task;
  }

  drain() {
    this.#drain();
  }

  canEnqueue(sessionId) {
    return !this.cancelFences.has(sessionId);
  }

  exactActivity(sessionId) {
    const waiting = new Set([...this.approvalWaiters.values()]
      .map((entry) => `${entry.sessionId}\u0000${entry.taskId}`));
    const rows = [];
    const active = this.active.get(sessionId);
    if (active) {
      rows.push({
        sessionId,
        taskId: active.task.id,
        phase: waiting.has(`${sessionId}\u0000${active.task.id}`) ? "waiting_approval" : "running",
      });
    }
    for (const { task, session } of this.queue) {
      if (session.id === sessionId) rows.push({ sessionId, taskId: task.id, phase: "queued" });
    }
    rows.sort((left, right) => left.taskId.localeCompare(right.taskId));
    return Object.freeze(rows.map((row) => Object.freeze(row)));
  }

  prepareCancel(sessionId, expectedTaskIds) {
    const expected = sortedUnique(Array.isArray(expectedTaskIds) ? expectedTaskIds : []);
    if (!sessionId || expected.length === 0 || this.cancelFences.has(sessionId)) {
      return { ok: false, reason: this.cancelFences.has(sessionId) ? "stop_in_progress" : "stale_target" };
    }
    const current = sortedUnique(this.exactActivity(sessionId).map((row) => row.taskId));
    if (!sameValues(current, expected)) return { ok: false, reason: current.length ? "stale_target" : "already_finished" };
    const generation = randomBytes(16).toString("hex");
    const plan = Object.freeze({ sessionId, taskIds: Object.freeze(expected), generation });
    this.cancelFences.set(sessionId, generation);
    this.cancelPlans.set(generation, plan);
    return { ok: true, plan };
  }

  commitCancel(plan) {
    if (!plan || this.cancelPlans.get(plan.generation) !== plan
      || this.cancelFences.get(plan.sessionId) !== plan.generation) {
      return { ok: false, reason: "stale_target" };
    }
    const expected = new Set(plan.taskIds);
    const current = sortedUnique(this.exactActivity(plan.sessionId).map((row) => row.taskId));
    if (!sameValues(current, plan.taskIds)) return { ok: false, reason: "stale_target" };

    const queued = [];
    this.queue = this.queue.filter((entry) => {
      if (entry.session.id !== plan.sessionId || !expected.has(entry.task.id)) return true;
      queued.push(entry);
      return false;
    });
    for (const { task, session } of queued) {
      this.knownTaskIds.delete(task.id);
      this.store.updateTask(task.id, "cancelled", "任务在启动前取消");
      this.store.updateSession(session.id, { status: "cancelled", last_summary: "任务在启动前取消" });
      Promise.resolve(this.onMessage(session, "任务已取消。", `cancel-${task.id}`)).catch((error) => {
        logger.error("取消通知失败", { taskId: task.id, sessionId: session.id, error: formatError(error) });
      });
    }

    for (const [approvalId, waiter] of this.approvalWaiters) {
      if (waiter.sessionId !== plan.sessionId || !expected.has(waiter.taskId)) continue;
      this.approvalWaiters.delete(approvalId);
      this.store.resolveApproval?.(approvalId, "cancelled");
      waiter.resolve("reject");
    }

    const active = this.active.get(plan.sessionId);
    if (active && expected.has(active.task.id)) active.abort.abort();
    return { ok: true, taskIds: [...plan.taskIds] };
  }

  releaseCancel(plan) {
    if (!plan || this.cancelPlans.get(plan.generation) !== plan) return false;
    this.cancelPlans.delete(plan.generation);
    if (this.cancelFences.get(plan.sessionId) === plan.generation) this.cancelFences.delete(plan.sessionId);
    return true;
  }

  cancel(sessionId) {
    const taskIds = this.exactActivity(sessionId).map((row) => row.taskId);
    const prepared = this.prepareCancel(sessionId, taskIds);
    if (!prepared.ok) return false;
    try { return this.commitCancel(prepared.plan).ok; } finally { this.releaseCancel(prepared.plan); }
  }

  resolveApproval(approvalId, accepted) {
    const waiter = this.approvalWaiters.get(approvalId);
    if (!waiter) return false;
    this.approvalWaiters.delete(approvalId);
    waiter.resolve(accepted ? "approve" : "reject");
    return true;
  }

  activitySnapshot(limit = 201) {
    const waiting = new Set([...this.approvalWaiters.values()]
      .map((entry) => `${entry.sessionId}\u0000${entry.taskId}`));
    const rows = [];
    for (const [sessionId, entry] of this.active) {
      const taskId = entry.task.id;
      rows.push({
        sessionId,
        taskId,
        phase: waiting.has(`${sessionId}\u0000${taskId}`) ? "waiting_approval" : "running",
        taskUpdatedAt: entry.task.updated_at || entry.task.created_at || 0,
        queuePosition: null,
      });
    }
    this.queue.forEach(({ task, session }, queuePosition) => rows.push({
      sessionId: session.id,
      taskId: task.id,
      phase: "queued",
      taskUpdatedAt: task.updated_at || task.created_at || 0,
      queuePosition,
    }));
    const priority = { waiting_approval: 0, running: 1, queued: 2 };
    rows.sort((left, right) => priority[left.phase] - priority[right.phase]
      || right.taskUpdatedAt - left.taskUpdatedAt
      || left.sessionId.localeCompare(right.sessionId)
      || left.taskId.localeCompare(right.taskId));
    return Object.freeze(rows.slice(0, limit).map((row) => Object.freeze(row)));
  }

  #drain() {
    while (this.runningProjects.size < this.maxConcurrentProjects) {
      const index = this.queue.findIndex((entry) => ![...this.runningProjects]
        .some((runningPath) => projectPathsConflict(runningPath, entry.session.project_path)));
      if (index < 0) break;
      const [entry] = this.queue.splice(index, 1);
      const projectKey = entry.session.project_path;
      this.runningProjects.add(projectKey);
      this.#run(entry).finally(() => {
        this.runningProjects.delete(projectKey);
        this.#drain();
      });
    }
  }

  async #requestApproval(session, task, request) {
    const approval = this.store.createApproval({ sessionId: session.id, taskId: task.id, description: request.description });
    this.store.updateSession(session.id, { status: "waiting_approval" });
    await this.onMessage(session, `需要确认 ${approval.id}\n${request.description}\n回复“批准 ${approval.id}”或“拒绝 ${approval.id}”。`, `approval-${approval.id}`);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.approvalWaiters.delete(approval.id);
        this.store.resolveApproval(approval.id, "expired");
        resolve("reject");
      }, 600000);
      timer.unref?.();
      this.approvalWaiters.set(approval.id, {
        sessionId: session.id,
        taskId: task.id,
        resolve: (decision) => {
          clearTimeout(timer);
          resolve(decision);
        },
      });
    });
  }

  async #run({ task, session }) {
    const abort = new AbortController();
    this.active.set(session.id, { abort, task });
    this.store.updateTask(task.id, "running");
    this.store.updateSession(session.id, { status: "running" });
    await this.onMessage(session, "已开始处理。", `start-${task.id}`);
    try {
      const executor = this.executors[session.executor];
      const result = await executor.run({
        session,
        content: task.content,
        signal: abort.signal,
        onApproval: (request) => this.#requestApproval(session, task, request),
        onNativeId: (nativeId) => {
          session = this.store.updateSession(session.id, { native_id: nativeId });
        },
      });
      this.store.updateTask(task.id, "completed", result.summary);
      const updated = this.store.updateSession(session.id, { native_id: result.nativeId, status: "completed", last_summary: result.summary });
      await this.onMessage(updated, result.summary, `done-${task.id}`);
    } catch (error) {
      const cancelled = error.name === "AbortError" || abort.signal.aborted;
      const status = cancelled ? "cancelled" : "failed";
      const summary = cancelled ? "任务已取消。" : `执行失败：${formatError(error)}`;
      this.store.updateTask(task.id, status, summary);
      const updated = this.store.updateSession(session.id, { status, last_summary: summary });
      await this.onMessage(updated, summary, `${status}-${task.id}`);
      logger.error("远程任务执行失败", { taskId: task.id, sessionId: session.id, error: formatError(error) });
    } finally {
      this.active.delete(session.id);
      this.knownTaskIds.delete(task.id);
    }
  }
}
