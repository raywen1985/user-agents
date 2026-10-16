import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Store } from "../src/store.mjs";

function withStore(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lark-stop-store-"));
  const store = new Store(path.join(directory, "test.sqlite"));
  try { return run(store); } finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}

const gatewayTarget = () => ({
  provider: "gateway",
  agent: "codex",
  sessionId: "CX-TEST",
  gatewayId: "CX-TEST",
  taskIds: ["TK-2", "TK-1", "TK-2"],
});

test("stop targets are opaque, normalized, and expire", () => {
  withStore((store) => {
    const created = store.createStopTarget(gatewayTarget(), 60000);
    assert.match(created.stopRef, /^ST-[0-9A-F]{32}$/);
    assert.deepEqual(created.target.taskIds, ["TK-1", "TK-2"]);
    assert.deepEqual(store.getStopTarget(created.stopRef).target, created.target);

    const expired = store.createStopTarget({
      provider: "codex", agent: "codex", sessionId: "thread-1", endpointId: "desktop", turnId: "turn-1",
    }, -1);
    store.cleanupStopState();
    assert.equal(store.getStopTarget(expired.stopRef), null);
  });
});

test("same reference and same target share exactly one active operation", () => {
  withStore((store) => {
    const firstRef = store.createStopTarget(gatewayTarget()).stopRef;
    const secondRef = store.createStopTarget(gatewayTarget()).stopRef;
    const first = store.claimStopOperation({
      stopRef: firstRef, messageId: "om-1", ownerEpoch: "epoch-1", ownerToken: "token-1",
    });
    const sameRef = store.claimStopOperation({
      stopRef: firstRef, messageId: "om-2", ownerEpoch: "epoch-1", ownerToken: "token-2",
    });
    const sameTarget = store.claimStopOperation({
      stopRef: secondRef, messageId: "om-3", ownerEpoch: "epoch-1", ownerToken: "token-3",
    });
    assert.equal(first.status, "claimed");
    assert.equal(first.ownsExecution, true);
    assert.equal(sameRef.status, "waiting");
    assert.equal(sameTarget.status, "waiting");
    assert.equal(sameRef.operation.id, first.operation.id);
    assert.equal(sameTarget.operation.id, first.operation.id);
  });
});

test("terminalization writes every current request reply atomically", () => {
  withStore((store) => {
    const stopRef = store.createStopTarget(gatewayTarget()).stopRef;
    const owner = store.claimStopOperation({
      stopRef, messageId: "om-owner", ownerEpoch: "epoch-1", ownerToken: "token-1",
    });
    store.claimStopOperation({
      stopRef, messageId: "om-waiter", ownerEpoch: "epoch-1", ownerToken: "token-2",
    });
    assert.equal(store.terminalizeStopOperation({
      operationId: owner.operation.id,
      ownerEpoch: "epoch-1",
      ownerToken: "token-1",
      outcome: "stopped",
      replyText: "Session 已停止。",
    }), true);
    assert.equal(store.nextOutbox().text, "Session 已停止。");
    store.markOutboxSent(store.nextOutbox().id);
    assert.equal(store.nextOutbox().text, "Session 已停止。");
    store.markOutboxSent(store.nextOutbox().id);
    assert.equal(store.nextOutbox(), null);

    const terminal = store.claimStopOperation({
      stopRef, messageId: "om-late", ownerEpoch: "epoch-1", ownerToken: "token-3",
    });
    assert.equal(terminal.status, "terminal");
    assert.equal(store.nextOutbox().dedupe_key, "internal-stop-om-late");
  });
});

test("fresh reference can retry after a no-signal terminal failure", () => {
  withStore((store) => {
    const firstRef = store.createStopTarget(gatewayTarget()).stopRef;
    const first = store.claimStopOperation({
      stopRef: firstRef, messageId: "om-first", ownerEpoch: "epoch-1", ownerToken: "token-1",
    });
    assert.equal(store.terminalizeStopOperation({
      operationId: first.operation.id,
      ownerEpoch: "epoch-1",
      ownerToken: "token-1",
      outcome: "snapshot_incomplete",
      replyText: "无法完整验证目标。",
      releaseActiveKey: true,
    }), true);

    const sameReference = store.claimStopOperation({
      stopRef: firstRef, messageId: "om-same", ownerEpoch: "epoch-1", ownerToken: "token-2",
    });
    assert.equal(sameReference.operation.id, first.operation.id);
    assert.equal(sameReference.status, "terminal");

    const freshRef = store.createStopTarget(gatewayTarget()).stopRef;
    const fresh = store.claimStopOperation({
      stopRef: freshRef, messageId: "om-fresh", ownerEpoch: "epoch-1", ownerToken: "token-3",
    });
    assert.equal(fresh.status, "claimed");
    assert.notEqual(fresh.operation.id, first.operation.id);
  });
});

test("pre-signal failures release once and terminalize with every reply on the second attempt", () => {
  withStore((store) => {
    const stopRef = store.createStopTarget(gatewayTarget()).stopRef;
    const first = store.claimStopOperation({
      stopRef, messageId: "om-owner", ownerEpoch: "epoch-1", ownerToken: "token-1",
    });
    assert.deepEqual(store.failStopAttempt({
      operationId: first.operation.id,
      ownerEpoch: "epoch-1",
      ownerToken: "token-1",
      outcome: "provider_error",
      replyText: "停止ID: {STOP_REF}\nprovider error",
    }), { status: "released", attempts: 1 });

    const second = store.claimStopOperation({
      stopRef, messageId: "om-owner", ownerEpoch: "epoch-1", ownerToken: "token-2",
    });
    assert.equal(second.ownsExecution, true);
    store.claimStopOperation({
      stopRef, messageId: "om-waiter", ownerEpoch: "epoch-1", ownerToken: "token-3",
    });
    assert.deepEqual(store.failStopAttempt({
      operationId: second.operation.id,
      ownerEpoch: "epoch-1",
      ownerToken: "token-2",
      outcome: "provider_error",
      replyText: "停止ID: {STOP_REF}\nprovider error",
    }), { status: "terminal", attempts: 2 });
    assert.equal(store.getStopOperation(first.operation.id).outcome, "provider_error");
    assert.equal(store.nextOutbox().text.includes(stopRef), true);
    store.markOutboxSent(store.nextOutbox().id);
    assert.equal(store.nextOutbox().text.includes(stopRef), true);
  });
});

test("startup repair restores a missing terminal outbox reply", () => {
  withStore((store) => {
    const stopRef = store.createStopTarget(gatewayTarget()).stopRef;
    const claim = store.claimStopOperation({
      stopRef, messageId: "om-repair", ownerEpoch: "epoch-1", ownerToken: "token-1",
    });
    store.terminalizeStopOperation({
      operationId: claim.operation.id,
      ownerEpoch: "epoch-1",
      ownerToken: "token-1",
      outcome: "stopped",
      replyText: "停止ID: {STOP_REF}\nSession 已停止。",
    });
    store.db.prepare("DELETE FROM outbox WHERE dedupe_key=?").run("internal-stop-om-repair");
    const [missing] = store.listStopRequestsMissingOutbox();
    assert.equal(missing.message_id, "om-repair");
    assert.equal(store.repairStopRequestOutbox(missing), true);
    assert.match(store.nextOutbox().text, new RegExp(stopRef));
  });
});

test("gateway instance replacement atomically reassigns stranded operations", () => {
  withStore((store) => {
    assert.deepEqual(store.claimGatewayInstance({
      pid: 100, procStart: "133700000000000000", epoch: "epoch-1",
    }), []);
    const stopRef = store.createStopTarget(gatewayTarget()).stopRef;
    const operation = store.claimStopOperation({
      stopRef, messageId: "om-1", ownerEpoch: "epoch-1", ownerToken: "token-1",
    }).operation;
    const previous = store.getGatewayInstanceOwner();
    const recovered = store.claimGatewayInstance({
      pid: 101, procStart: "133700000000000001", epoch: "epoch-2", expectedOwner: previous,
    });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].operationId, operation.id);
    const updated = store.getStopOperation(operation.id);
    assert.equal(updated.owner_epoch, "epoch-2");
    assert.equal(updated.owner_token, recovered[0].ownerToken);
    assert.equal(store.markGatewayInstanceDraining("epoch-2"), true);
    assert.equal(store.getGatewayInstanceOwner().state, "draining");
    assert.throws(() => store.claimGatewayInstance({
      pid: 102, procStart: "133700000000000002", epoch: "epoch-3", expectedOwner: previous,
    }), /owner changed/);
  });
});
