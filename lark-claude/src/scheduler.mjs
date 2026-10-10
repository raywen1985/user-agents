import { formatError, formatSessionMessage } from "./format.mjs";
import { logger } from "./logger.mjs";

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
  }

  enqueue(task, session) {
    this.queue.push({ task, session });
    this.#drain();
  }

  cancel(sessionId) {
    const active = this.active.get(sessionId);
    if (active) {
      active.abort.abort();
      return true;
    }
    const index = this.queue.findIndex((entry) => entry.session.id === sessionId);
    if (index >= 0) {
      const [{ task, session }] = this.queue.splice(index, 1);
      this.store.updateTask(task.id, "cancelled", "任务在启动前取消");
      this.store.updateSession(session.id, { status: "cancelled", last_summary: "任务在启动前取消" });
      this.onMessage(session, "任务已取消。", `cancel-${task.id}`);
      return true;
    }
    return false;
  }

  resolveApproval(approvalId, accepted) {
    const waiter = this.approvalWaiters.get(approvalId);
    if (!waiter) return false;
    this.approvalWaiters.delete(approvalId);
    waiter.resolve(accepted ? "approve" : "reject");
    return true;
  }

  #drain() {
    while (this.runningProjects.size < this.maxConcurrentProjects) {
      const index = this.queue.findIndex((entry) => !this.runningProjects.has(entry.session.project_path.toLowerCase()));
      if (index < 0) break;
      const [entry] = this.queue.splice(index, 1);
      const projectKey = entry.session.project_path.toLowerCase();
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
        resolve: (decision) => {
          clearTimeout(timer);
          resolve(decision);
        },
      });
    });
  }

  async #run({ task, session }) {
    const abort = new AbortController();
    this.active.set(session.id, { abort, taskId: task.id });
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
    }
  }
}
