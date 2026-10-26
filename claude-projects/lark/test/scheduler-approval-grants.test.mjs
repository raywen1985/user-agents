import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Scheduler } from "../src/scheduler.mjs";
import { Store } from "../src/store.mjs";

function withStore(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-grants-"));
  const store = new Store(path.join(root, "gateway.sqlite"));
  return Promise.resolve(run(store)).finally(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
}

function completedSignal() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("typed task profile covers eligible SVN operations without prompts", () => withStore(async (store) => {
  const session = store.createSession({ executor: "codex", projectAlias: "p", projectPath: "C:\\p", name: "work" });
  const task = store.createTask({
    sessionId: session.id,
    messageId: "om-profile",
    action: "new",
    content: "还原svn所有修改",
    approvalProfile: { version: 1, grants: ["svn-status", "svn-revert"] },
  });
  const decisions = [];
  const done = completedSignal();
  const scheduler = new Scheduler({
    store,
    executors: { codex: { async run({ onApproval }) {
      decisions.push(await onApproval({ description: "status", operationClass: "svn-status", grantEligible: true }));
      decisions.push(await onApproval({ description: "revert", operationClass: "svn-revert", grantEligible: true }));
      return { summary: "done", nativeId: "native" };
    } } },
    onMessage(_session, body) { if (body === "done") done.resolve(); },
  });
  scheduler.enqueue(task, session);
  await done.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(decisions, ["approve", "approve"]);
  assert.equal(store.listPendingApprovals().length, 0);
  assert.equal(scheduler.taskGrants.has(task.id), false);
}));

test("class grant covers only the same eligible operation class", () => withStore(async (store) => {
  const session = store.createSession({ executor: "codex", projectAlias: "p", projectPath: "C:\\p", name: "work" });
  const task = store.createTask({ sessionId: session.id, messageId: "om-class", action: "new", content: "work" });
  const decisions = [];
  const prompts = [];
  const done = completedSignal();
  let scheduler;
  scheduler = new Scheduler({
    store,
    executors: { codex: { async run({ onApproval }) {
      decisions.push(await onApproval({ description: "first", operationClass: "svn-revert", grantEligible: true }));
      decisions.push(await onApproval({ description: "second", operationClass: "svn-revert", grantEligible: true }));
      decisions.push(await onApproval({ description: "other", operationClass: "publish", grantEligible: false }));
      return { summary: "done", nativeId: "native" };
    } } },
    onMessage(_session, body, _key, options = {}) {
      if (options.approvalId) {
        prompts.push(options.approvalId);
        if (prompts.length === 1) assert.equal(scheduler.resolveApprovalGrant(options.approvalId, "class").ok, true);
        else {
          assert.equal(scheduler.resolveApproval(options.approvalId, true), true);
          store.resolveApproval(options.approvalId, "approved");
        }
      }
      if (body === "done") done.resolve();
    },
  });
  scheduler.enqueue(task, session);
  await done.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(decisions, ["approve", "approve", "approve"]);
  assert.equal(prompts.length, 2);
  assert.equal(scheduler.taskGrants.has(task.id), false);
}));
