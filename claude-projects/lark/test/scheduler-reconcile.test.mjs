import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Scheduler } from "../src/scheduler.mjs";
import { Store } from "../src/store.mjs";

function withStore(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-reconcile-"));
  const store = new Store(path.join(root, "gateway.sqlite"));
  return Promise.resolve(run(store)).finally(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
}

test("persistent queued tasks are projected idempotently", () => withStore((store) => {
  const session = store.createSession({ executor: "codex", projectAlias: "agents", projectPath: "C:\\agents", name: "work" });
  const task = store.createTask({ sessionId: session.id, messageId: "om-task", action: "new", content: "work" });
  const scheduler = new Scheduler({ store, executors: {}, onMessage() {}, maxConcurrentProjects: 0 });
  assert.equal(scheduler.reconcileQueuedTasks({ drain: false }), 1);
  assert.equal(scheduler.reconcileQueuedTasks({ drain: false }), 0);
  assert.deepEqual(scheduler.exactActivity(session.id).map((entry) => entry.taskId), [task.id]);
}));

test("a task persisted behind a stop fence is projected when the fence releases", () => withStore((store) => {
  const session = store.createSession({ executor: "codex", projectAlias: "agents", projectPath: "C:\\agents", name: "work" });
  const first = store.createTask({ sessionId: session.id, messageId: "om-first", action: "new", content: "first" });
  const scheduler = new Scheduler({ store, executors: {}, onMessage() {}, maxConcurrentProjects: 0 });
  scheduler.enqueue(first, session, { defer: true });
  const prepared = scheduler.prepareCancel(session.id, [first.id]);
  assert.equal(prepared.ok, true);
  assert.equal(scheduler.commitCancel(prepared.plan).ok, true);

  const deferred = store.createTask({ sessionId: session.id, messageId: "om-deferred", action: "continue", content: "second" });
  assert.equal(scheduler.reconcileQueuedTasks({ drain: false }), 0);
  assert.equal(scheduler.releaseCancel(prepared.plan), true);
  assert.deepEqual(scheduler.exactActivity(session.id).map((entry) => entry.taskId), [deferred.id]);
}));
