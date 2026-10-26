import assert from "node:assert/strict";
import test from "node:test";
import { createStopTargetDecorator } from "../src/stop-targets.mjs";

function harness(overrides = {}) {
  const targets = [];
  const decorator = createStopTargetDecorator({
    store: { createStopTarget(target) { targets.push(target); return { stopRef: `ST-${String(targets.length).padStart(32, "0")}` }; } },
    getGatewayActivities: async () => [],
    exactClaude: async (input) => ({ ok: true, record: input }),
    probeClaude: async () => "live",
    exactCodex: async ({ threadId }) => ({ threadId, turnId: "turn-1", status: "inProgress" }),
    codexControl: { probeExactOwner: async () => ({ ready: false, reason: "control_unreachable" }) },
    ...overrides,
  });
  return { decorator, targets };
}

test("Gateway stop binding uses the uncapped exact owner task set", async () => {
  const nativeId = "11111111-1111-4111-8111-111111111111";
  const { decorator, targets } = harness({
    getGatewayActivities: async () => [
      { agent: "codex", nativeId, gatewayId: "CX-1", taskId: "TK-2" },
      { agent: "codex", nativeId, gatewayId: "CX-1", taskId: "TK-1" },
    ],
  });
  const [record] = await decorator([{ provider: "gateway+codex", agent: "codex", nativeId, gatewayId: "CX-1" }]);
  assert.equal(record.stopCapability.ready, true);
  assert.deepEqual(targets[0], {
    provider: "gateway", agent: "codex", sessionId: "CX-1", nativeId,
    gatewayId: "CX-1", taskIds: ["TK-1", "TK-2"],
  });
});

test("hidden second Gateway owner suppresses the stop reference", async () => {
  const nativeId = "11111111-1111-4111-8111-111111111111";
  const { decorator, targets } = harness({
    getGatewayActivities: async () => [
      { agent: "codex", nativeId, gatewayId: "CX-1", taskId: "TK-1" },
      { agent: "codex", nativeId, gatewayId: "CX-HIDDEN", taskId: "TK-2" },
    ],
  });
  const [record] = await decorator([{ provider: "gateway", agent: "codex", nativeId, gatewayId: "CX-1" }]);
  assert.equal(record.stopRef, undefined);
  assert.equal(record.stopCapability.reason, "ambiguous_control_owner");
  assert.deepEqual(targets, []);
});

test("Claude target is minted only after exact registry and process validation", async () => {
  const sessionId = "33333333-3333-4333-8333-333333333333";
  const sourcePath = "C:\\Users\\Administrator\\.claude\\sessions\\test.json";
  const { decorator, targets } = harness();
  const [record] = await decorator([{
    provider: "claude", agent: "claude", nativeId: sessionId, sessionId,
    pid: 42, procStart: "133700000000000000", sourcePath,
  }]);
  assert.equal(record.stopCapability.ready, true);
  assert.equal(targets[0].pid, 42);
  assert.equal(targets[0].sourcePath, sourcePath);
});

test("Codex target remains unavailable without one reachable exact owner", async () => {
  const { decorator, targets } = harness();
  const [record] = await decorator([{
    provider: "codex", agent: "codex", nativeId: "thread-1", sessionId: "thread-1", turnId: "turn-1",
  }]);
  assert.equal(record.stopCapability.reason, "control_unreachable");
  assert.deepEqual(targets, []);
});
