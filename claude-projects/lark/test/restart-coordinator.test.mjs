import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RestartCoordinator } from "../src/restart-coordinator.mjs";

function fixture(t, { activities = [], onStop = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-restart-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const markerPath = path.join(root, "restart-request.json");
  fs.writeFileSync(markerPath, JSON.stringify({ requestedAt: new Date().toISOString(), nonce: "0123456789abcdef" }));
  const calls = [];
  const health = [];
  const listener = {
    async stop() { calls.push("stop"); await onStop?.(); },
    async start() { calls.push("start"); },
  };
  const scheduler = {
    reconcileQueuedTasks(options) { calls.push(options?.drain === false ? "reconcile-hold" : "reconcile"); },
    activitySnapshot() { return activities; },
  };
  const store = { listQueuedTasks: () => [] };
  const coordinator = new RestartCoordinator({
    markerPath, listener, scheduler, store,
    handleMessage: async () => { calls.push("handle"); },
    persistFencedMessage: async () => { calls.push("persist"); },
    replayPending: async () => { calls.push("replay"); },
    updateHealth: (value) => health.push(value),
    onRestartReady: async () => { calls.push("exit"); },
  });
  return { coordinator, markerPath, calls, health };
}

test("restart fence defers when work arrives while the listener is stopping", async (t) => {
  const activities = [];
  const subject = fixture(t, {
    activities,
    onStop: async () => { activities.push({ taskId: "TASK-RACE" }); },
  });
  assert.equal(await subject.coordinator.check(), "deferred");
  assert.deepEqual(subject.calls, ["stop", "reconcile-hold", "start", "replay", "reconcile"]);
  assert.equal(fs.existsSync(subject.markerPath), false);
  assert.equal(subject.health.at(-1).restartDeferred, true);
});

test("idle restart fence reports ready and leaves marker for the deploy command", async (t) => {
  const subject = fixture(t);
  assert.equal(await subject.coordinator.check(), "ready");
  assert.deepEqual(subject.calls, ["stop", "reconcile-hold", "exit"]);
  assert.equal(fs.existsSync(subject.markerPath), true);
  assert.equal(subject.health.at(-1).restartReady, true);
});

test("messages observed after the fence are persisted instead of handled", async (t) => {
  let release;
  const subject = fixture(t, { onStop: () => new Promise((resolve) => { release = resolve; }) });
  const checking = subject.coordinator.check();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await subject.coordinator.dispatch({ message_id: "om-fenced" }), "fenced");
  release();
  await checking;
  assert.ok(subject.calls.includes("persist"));
  assert.ok(!subject.calls.includes("handle"));
});

test("malformed restart marker is removed without fencing", async (t) => {
  const subject = fixture(t);
  fs.writeFileSync(subject.markerPath, "not-json");
  assert.equal(await subject.coordinator.check(), "invalid");
  assert.equal(fs.existsSync(subject.markerPath), false);
  assert.deepEqual(subject.calls, []);
  assert.match(subject.health.at(-1).restartError, /JSON/);
});
