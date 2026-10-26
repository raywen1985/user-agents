import assert from "node:assert/strict";
import test from "node:test";
import { Scheduler } from "../src/scheduler.mjs";

function harness() {
  const calls = [];
  const store = {
    updateTask(...args) { calls.push(["task", ...args]); },
    updateSession(...args) { calls.push(["session", ...args]); },
    resolveApproval(...args) { calls.push(["approval", ...args]); },
  };
  const scheduler = new Scheduler({ store, executors: {}, onMessage() {}, maxConcurrentProjects: 0 });
  return { scheduler, calls };
}

test("prepareCancel binds the exact complete task set without side effects", () => {
  const { scheduler, calls } = harness();
  scheduler.queue.push(
    { task: { id: "TK-2" }, session: { id: "CX-1" } },
    { task: { id: "TK-1" }, session: { id: "CX-1" } },
  );
  assert.deepEqual(scheduler.prepareCancel("CX-1", ["TK-1"]), { ok: false, reason: "stale_target" });
  const prepared = scheduler.prepareCancel("CX-1", ["TK-2", "TK-1"]);
  assert.equal(prepared.ok, true);
  assert.deepEqual(prepared.plan.taskIds, ["TK-1", "TK-2"]);
  assert.deepEqual(calls, []);
  assert.throws(() => scheduler.enqueue({ id: "TK-3" }, { id: "CX-1" }), /正在停止/);
  assert.equal(scheduler.releaseCancel(prepared.plan), true);
});

test("a cancellation fence rejects continuation before task creation", () => {
  const { scheduler } = harness();
  scheduler.queue.push({ task: { id: "TK-1" }, session: { id: "CX-1" } });
  const prepared = scheduler.prepareCancel("CX-1", ["TK-1"]);
  let created = 0;
  assert.throws(() => scheduler.enqueueFactory({ id: "CX-1" }, () => {
    created += 1;
    return { id: "TK-2" };
  }), /正在停止/);
  assert.equal(created, 0);
  assert.deepEqual(scheduler.exactActivity("CX-1").map((row) => row.taskId), ["TK-1"]);
  scheduler.releaseCancel(prepared.plan);
});

test("commitCancel affects only tasks captured by the validated plan", () => {
  const { scheduler, calls } = harness();
  const activeAbort = new AbortController();
  scheduler.active.set("CX-1", { task: { id: "TK-A" }, abort: activeAbort });
  scheduler.queue.push(
    { task: { id: "TK-Q" }, session: { id: "CX-1" } },
    { task: { id: "TK-OTHER" }, session: { id: "CX-2" } },
  );
  let approvalDecision = null;
  scheduler.approvalWaiters.set("RQ-1", {
    sessionId: "CX-1", taskId: "TK-A", resolve(value) { approvalDecision = value; },
  });
  const prepared = scheduler.prepareCancel("CX-1", ["TK-Q", "TK-A"]);
  assert.equal(prepared.ok, true);
  assert.deepEqual(scheduler.commitCancel(prepared.plan), { ok: true, taskIds: ["TK-A", "TK-Q"] });
  assert.equal(activeAbort.signal.aborted, true);
  assert.equal(approvalDecision, "reject");
  assert.deepEqual(scheduler.queue.map((entry) => entry.task.id), ["TK-OTHER"]);
  assert.equal(calls.some((call) => call[0] === "task" && call[1] === "TK-Q" && call[2] === "cancelled"), true);
  scheduler.releaseCancel(prepared.plan);
});

test("commitCancel fails closed if the task set changes after preparation", () => {
  const { scheduler, calls } = harness();
  scheduler.queue.push({ task: { id: "TK-1" }, session: { id: "CX-1" } });
  const prepared = scheduler.prepareCancel("CX-1", ["TK-1"]);
  scheduler.queue.push({ task: { id: "TK-2" }, session: { id: "CX-1" } });
  assert.deepEqual(scheduler.commitCancel(prepared.plan), { ok: false, reason: "stale_target" });
  assert.deepEqual(calls, []);
  assert.equal(scheduler.releaseCancel(prepared.plan), true);
});

test("legacy cancel uses the same exact fenced plan", () => {
  const { scheduler } = harness();
  scheduler.queue.push({ task: { id: "TK-1" }, session: { id: "CX-1" } });
  assert.equal(scheduler.cancel("CX-1"), true);
  assert.equal(scheduler.exactActivity("CX-1").length, 0);
  assert.equal(scheduler.canEnqueue("CX-1"), true);
  assert.equal(scheduler.cancel("CX-MISSING"), false);
});
