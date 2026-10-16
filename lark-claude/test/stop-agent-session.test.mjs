import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Scheduler } from "../src/scheduler.mjs";
import { createStopAgentSession } from "../src/stop-agent-session.mjs";
import { Store } from "../src/store.mjs";

async function withStore(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lark-stop-handler-"));
  const store = new Store(path.join(directory, "test.sqlite"));
  try { return await run(store); } finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}

function dependencies(store, overrides = {}) {
  return {
    store,
    scheduler: overrides.scheduler,
    ownerEpoch: "epoch-1",
    getGatewayActivities: async () => [],
    exactClaude: async (target) => ({ ok: true, record: target }),
    probeClaude: async () => "live",
    terminateClaude: async () => ({ state: "terminated" }),
    exactCodex: async ({ threadId }) => ({ threadId, turnId: "turn-1", status: "inProgress" }),
    codexControl: {
      probeExactOwner: async () => ({ ready: false, reason: "control_unreachable" }),
      interruptExact: async () => ({ ok: false, outcome: "control_unreachable" }),
    },
    sleep: async () => {},
    ...overrides,
  };
}

test("Gateway stop cancels only the exact bound task set", async () => {
  await withStore(async (store) => {
    const session = store.createSession({ executor: "codex", projectAlias: "test", projectPath: "C:\\test", name: "test" });
    const task = store.createTask({ sessionId: session.id, messageId: "task-message", action: "new", content: "work" });
    const scheduler = new Scheduler({ store, executors: {}, onMessage() {}, maxConcurrentProjects: 0 });
    scheduler.queue.push({ task, session });
    const activities = () => store.enrichActivitySnapshot(scheduler.activitySnapshot(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
    const stopRef = store.createStopTarget({
      provider: "gateway", agent: "codex", sessionId: session.id, gatewayId: session.id, taskIds: [task.id],
    }).stopRef;
    const stop = createStopAgentSession(dependencies(store, { scheduler, getGatewayActivities: async () => activities() }));
    assert.deepEqual(await stop({ sessionRef: stopRef, messageId: "om-stop" }), { handledByOutbox: true });
    assert.equal(store.getTask(task.id).status, "cancelled");
    assert.match(store.nextOutbox().text, /Session 已停止/);
    assert.match(store.nextOutbox().text, new RegExp(stopRef));
  });
});

test("Claude stop maps retained-handle termination to verified success", async () => {
  await withStore(async (store) => {
    const stopRef = store.createStopTarget({
      provider: "claude", agent: "claude", sessionId: "33333333-3333-4333-8333-333333333333",
      pid: 42, procStart: "133700000000000000", sourcePath: "C:\\test\\session.json",
    }).stopRef;
    let terminated = 0;
    const stop = createStopAgentSession(dependencies(store, {
      terminateClaude: async () => { terminated += 1; return { state: "terminated" }; },
    }));
    await stop({ sessionRef: stopRef, messageId: "om-stop" });
    assert.equal(terminated, 1);
    assert.match(store.nextOutbox().text, /Session 已停止/);
  });
});

test("pre-signal identity failure never calls a broader Claude fallback", async () => {
  await withStore(async (store) => {
    const stopRef = store.createStopTarget({
      provider: "claude", agent: "claude", sessionId: "33333333-3333-4333-8333-333333333333",
      pid: 42, procStart: "133700000000000000", sourcePath: "C:\\test\\session.json",
    }).stopRef;
    let terminated = 0;
    const stop = createStopAgentSession(dependencies(store, {
      exactClaude: async () => ({ ok: false, reason: "identity_changed" }),
      terminateClaude: async () => { terminated += 1; return { state: "terminated" }; },
    }));
    await stop({ sessionRef: stopRef, messageId: "om-stop" });
    assert.equal(terminated, 0);
    assert.match(store.nextOutbox().text, /身份已变化/);
  });
});

test("Codex stop never falls back to process termination when control is unreachable", async () => {
  await withStore(async (store) => {
    const stopRef = store.createStopTarget({
      provider: "codex", agent: "codex", sessionId: "thread-1", endpointId: "desktop", turnId: "turn-1",
    }).stopRef;
    let interrupted = 0;
    const stop = createStopAgentSession(dependencies(store, {
      codexControl: {
        probeExactOwner: async () => ({ ready: false, reason: "control_unreachable" }),
        interruptExact: async () => { interrupted += 1; return { ok: true, outcome: "stopped" }; },
      },
    }));
    await stop({ sessionRef: stopRef, messageId: "om-stop" });
    assert.equal(interrupted, 0);
    assert.match(store.nextOutbox().text, /控制通道不可达/);
  });
});

test("pre-signal provider exceptions retry once and then reply with a bounded error", async () => {
  await withStore(async (store) => {
    const stopRef = store.createStopTarget({
      provider: "claude", agent: "claude", sessionId: "33333333-3333-4333-8333-333333333333",
      pid: 42, procStart: "133700000000000000", sourcePath: "C:\\test\\session.json",
    }).stopRef;
    let attempts = 0;
    const stop = createStopAgentSession(dependencies(store, {
      exactClaude: async () => { attempts += 1; throw new Error("private provider detail"); },
    }));
    await stop({ sessionRef: stopRef, messageId: "om-stop" });
    assert.equal(attempts, 2);
    assert.match(store.nextOutbox().text, /受控的 provider 错误/);
    assert.doesNotMatch(store.nextOutbox().text, /private provider detail/);
  });
});

test("a contender times out without sending a second stop signal", async () => {
  await withStore(async (store) => {
    const stopRef = store.createStopTarget({
      provider: "claude", agent: "claude", sessionId: "33333333-3333-4333-8333-333333333333",
      pid: 42, procStart: "133700000000000000", sourcePath: "C:\\test\\session.json",
    }).stopRef;
    store.claimStopOperation({
      stopRef, messageId: "om-owner", ownerEpoch: "epoch-1", ownerToken: "owner-token",
    });
    let terminated = 0;
    const stop = createStopAgentSession(dependencies(store, {
      contenderWaitMs: -1,
      terminateClaude: async () => { terminated += 1; return { state: "terminated" }; },
    }));
    await stop({ sessionRef: stopRef, messageId: "om-contender" });
    assert.equal(terminated, 0);
    assert.match(store.nextOutbox().text, /正在停止处理中/);
  });
});

test("Gateway signaling recovery succeeds only when every bound task is cancelled", async () => {
  await withStore(async (store) => {
    const session = store.createSession({ executor: "codex", projectAlias: "test", projectPath: "C:\\test", name: "test" });
    const first = store.createTask({ sessionId: session.id, messageId: "task-1", action: "new", content: "work" });
    const second = store.createTask({ sessionId: session.id, messageId: "task-2", action: "continue", content: "more" });
    store.updateTask(first.id, "cancelled");
    store.updateTask(second.id, "cancelled");
    const scheduler = new Scheduler({ store, executors: {}, onMessage() {}, maxConcurrentProjects: 0 });
    const stopRef = store.createStopTarget({
      provider: "gateway", agent: "codex", sessionId: session.id, gatewayId: session.id, taskIds: [first.id, second.id],
    }).stopRef;
    const claim = store.claimStopOperation({ stopRef, messageId: "om-recover", ownerEpoch: "epoch-1", ownerToken: "token-1" });
    assert.equal(store.markStopSignaling(claim.operation.id, "epoch-1", "token-1"), true);
    const stop = createStopAgentSession(dependencies(store, { scheduler }));
    assert.equal(await stop.recover(store.getStopOperation(claim.operation.id)), true);
    assert.equal(store.getStopOperation(claim.operation.id).outcome, "stopped");
  });
});

test("Gateway mixed recovery state is uncertain and never widens cancellation", async () => {
  await withStore(async (store) => {
    const session = store.createSession({ executor: "codex", projectAlias: "test", projectPath: "C:\\test", name: "test" });
    const first = store.createTask({ sessionId: session.id, messageId: "task-1", action: "new", content: "work" });
    const second = store.createTask({ sessionId: session.id, messageId: "task-2", action: "continue", content: "more" });
    store.updateTask(first.id, "cancelled");
    store.updateTask(second.id, "interrupted");
    const scheduler = new Scheduler({ store, executors: {}, onMessage() {}, maxConcurrentProjects: 0 });
    const stopRef = store.createStopTarget({
      provider: "gateway", agent: "codex", sessionId: session.id, gatewayId: session.id, taskIds: [first.id, second.id],
    }).stopRef;
    const claim = store.claimStopOperation({ stopRef, messageId: "om-recover", ownerEpoch: "epoch-1", ownerToken: "token-1" });
    store.markStopSignaling(claim.operation.id, "epoch-1", "token-1");
    const stop = createStopAgentSession(dependencies(store, { scheduler }));
    await stop.recover(store.getStopOperation(claim.operation.id));
    assert.equal(store.getStopOperation(claim.operation.id).state, "uncertain");
    assert.equal(store.getStopOperation(claim.operation.id).outcome, "uncertain");
  });
});

test("Gateway signaling recovery treats restart-interrupted work as uncertain", async () => {
  await withStore(async (store) => {
    const session = store.createSession({ executor: "codex", projectAlias: "test", projectPath: "C:\\test", name: "test" });
    const task = store.createTask({ sessionId: session.id, messageId: "task-1", action: "new", content: "work" });
    store.updateTask(task.id, "interrupted");
    const scheduler = new Scheduler({ store, executors: {}, onMessage() {}, maxConcurrentProjects: 0 });
    const stopRef = store.createStopTarget({
      provider: "gateway", agent: "codex", sessionId: session.id, gatewayId: session.id, taskIds: [task.id],
    }).stopRef;
    const claim = store.claimStopOperation({ stopRef, messageId: "om-recover", ownerEpoch: "epoch-1", ownerToken: "token-1" });
    store.markStopSignaling(claim.operation.id, "epoch-1", "token-1");
    const stop = createStopAgentSession(dependencies(store, { scheduler }));
    await stop.recover(store.getStopOperation(claim.operation.id));
    assert.equal(store.getStopOperation(claim.operation.id).state, "uncertain");
    assert.equal(store.getStopOperation(claim.operation.id).outcome, "uncertain");
  });
});
