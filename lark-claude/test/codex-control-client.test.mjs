import assert from "node:assert/strict";
import test from "node:test";
import { CodexControlManager } from "../src/codex-control-client.mjs";

function fakeConnection({ threadId = "thread-1", turnId = "turn-1", statuses = ["inProgress"] } = {}) {
  const calls = [];
  let readIndex = 0;
  return {
    calls,
    closed: false,
    async request(method, params) {
      calls.push({ method, params });
      if (method === "thread/loaded/list") return { data: [{ id: threadId }], nextCursor: null };
      if (method === "thread/read") {
        const status = statuses[Math.min(readIndex++, statuses.length - 1)];
        return { thread: { id: threadId, turns: [{ id: turnId, status }] } };
      }
      if (method === "turn/interrupt") return {};
      throw new Error(`Unexpected method ${method}`);
    },
    close() { this.closed = true; },
  };
}

test("Codex owner probing requires one endpoint with the exact active turn", async () => {
  const connection = fakeConnection();
  const manager = new CodexControlManager({
    config: { endpoints: [{ id: "desktop", transport: "proxy" }] },
    connectEndpoint: async () => connection,
  });
  const result = await manager.probeExactOwner({ threadId: "thread-1", turnId: "turn-1" });
  assert.equal(result.ready, true);
  assert.equal(result.endpointId, "desktop");
  assert.deepEqual(connection.calls.map((call) => call.method), ["thread/loaded/list", "thread/read"]);
  result.connection.close();
});

test("Codex owner probing rejects multiple owners", async () => {
  const connections = [fakeConnection(), fakeConnection()];
  let index = 0;
  const manager = new CodexControlManager({
    config: { endpoints: [{ id: "a" }, { id: "b" }] },
    connectEndpoint: async () => connections[index++],
  });
  assert.deepEqual(await manager.probeExactOwner({ threadId: "thread-1", turnId: "turn-1" }), {
    ready: false, reason: "ambiguous_control_owner",
  });
  assert.equal(connections.every((connection) => connection.closed), true);
});

test("Codex interrupt verifies only the captured turn reaches interrupted", async () => {
  const connection = fakeConnection({ statuses: ["inProgress", "interrupted"] });
  const manager = new CodexControlManager({
    config: { endpoints: [{ id: "desktop" }] },
    connectEndpoint: async () => connection,
    sleep: async () => {},
  });
  assert.deepEqual(await manager.interruptExact({
    endpointId: "desktop", threadId: "thread-1", turnId: "turn-1",
  }), { ok: true, outcome: "stopped" });
  const interrupt = connection.calls.find((call) => call.method === "turn/interrupt");
  assert.deepEqual(interrupt.params, { threadId: "thread-1", turnId: "turn-1" });
  assert.equal(connection.closed, true);
});

test("Codex natural completion is not reported as a successful stop", async () => {
  const connection = fakeConnection({ statuses: ["inProgress", "completed"] });
  const manager = new CodexControlManager({
    config: { endpoints: [{ id: "desktop" }] },
    connectEndpoint: async () => connection,
    sleep: async () => {},
  });
  assert.deepEqual(await manager.interruptExact({
    endpointId: "desktop", threadId: "thread-1", turnId: "turn-1",
  }), { ok: false, outcome: "completion_race" });
});

test("Codex Desktop is never controlled when no endpoint is configured", async () => {
  let connected = false;
  const manager = new CodexControlManager({
    config: { endpoints: [] },
    connectEndpoint: async () => { connected = true; throw new Error("unexpected"); },
  });
  assert.deepEqual(await manager.probeExactOwner({ threadId: "thread-1", turnId: "turn-1" }), {
    ready: false, reason: "control_unreachable",
  });
  assert.equal(connected, false);
});
