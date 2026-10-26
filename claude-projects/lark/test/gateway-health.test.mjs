import assert from "node:assert/strict";
import test from "node:test";
import { buildGatewayHealth, processStartFileTimeToIso } from "../src/gateway-health.mjs";

test("converts a Windows process FILETIME to RFC 3339 UTC", () => {
  assert.equal(processStartFileTimeToIso("134363325751890000"), "2026-10-13T02:36:15.189Z");
});

test("rejects malformed or out-of-range process FILETIME values", () => {
  for (const value of [null, "", "123", "not-a-time", "116444735999999999", "99999999999999999999"]) {
    assert.throws(() => processStartFileTimeToIso(value), /process FILETIME/i);
  }
});

test("keeps process identity immutable across health state updates", () => {
  const identity = {
    pid: 42,
    procStart: "134363325751890000",
    processStartedAt: "2026-10-11T07:56:15.189Z",
    installationGeneration: "a".repeat(32),
    nodeExecutable: "node.exe",
    gatewayEntry: "gateway.mjs",
  };
  const document = buildGatewayHealth({
    identity,
    listenerReady: true,
    updatedAt: "2026-10-25T01:02:03.000Z",
    state: {
      pid: 99,
      processStartedAt: "2099-01-01T00:00:00.000Z",
      startedAt: "2026-10-25T01:00:00.000Z",
      stopping: false,
    },
  });

  assert.equal(document.pid, 42);
  assert.equal(document.processStartedAt, identity.processStartedAt);
  assert.equal(document.startedAt, "2026-10-25T01:00:00.000Z");
  assert.equal(document.listenerReady, true);
  assert.equal(document.updatedAt, "2026-10-25T01:02:03.000Z");
});
