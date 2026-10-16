import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CcSwitchReadError } from "../src/ccswitch-reader.mjs";
import { createCcSwitchSkill, formatCcSwitchResult } from "../src/ccswitch-skill.mjs";
import { Store } from "../src/store.mjs";

function metric(overrides = {}) {
  return {
    requests: 2, successes: 1, successRate: 50,
    inputTokensBySemantics: { 1: 10, 2: 20 }, outputTokens: 30,
    cacheReadTokens: 4, cacheCreationTokens: 5, estimatedCostUsd: "0.123456",
    averageLatencyMs: 100, latencyEstimated: true, ...overrides,
  };
}

test("formats every action with bounded public fields", () => {
  const results = [
    {
      action: "overview", installed: true, applicationVersion: null, databaseSchemaVersion: 18,
      databaseLastWriteAt: "2026-10-14T00:00:00.000Z", latestDetail: { state: "ok", value: "2026-10-14T00:00:00.000Z" },
      latestRollup: { state: "empty", value: null }, rows: [{ appLabel: "claude", currentProvider: "Primary", enabled: true, proxyEnabled: true }], omitted: 0,
    },
    { action: "providers", rows: [{ appLabel: "claude", name: "Primary", current: true, category: "official", providerType: "anthropic", endpointOrigin: "https://api.example.com" }], omitted: 0 },
    { action: "health", rows: [{ appLabel: "claude", providerName: "Primary", state: "healthy", stale: false, consecutiveFailures: 0, updatedAt: "2026-10-14T00:00:00.000Z" }], omitted: 0 },
    { action: "routing_status", rows: [{ appLabel: "claude", enabled: true, proxyEnabled: true, listenClass: "loopback", listenPort: 15721, loggingEnabled: true, failoverEnabled: false, liveTakeoverActive: false, updatedAt: "2026-10-14T00:00:00.000Z" }], omitted: 0 },
    { action: "usage", period: "today", coverage: "observed_only", potentiallyIncomplete: false, totals: metric(), breakdowns: { app: { rows: [{ label: "claude", ...metric() }], omitted: 0 }, provider: { rows: [], omitted: 0 }, model: { rows: [], omitted: 0 } } },
  ];
  for (const result of results) {
    const text = formatCcSwitchResult(result);
    assert.ok(Buffer.byteLength(text, "utf8") <= 12288);
    assert.doesNotMatch(text, /undefined|\[object Object\]/);
  }
});

test("skill maps failures and diagnostics without propagating raw errors", async () => {
  const diagnostics = [];
  const skill = createCcSwitchSkill({
    reader: { read: async () => { throw Object.assign(new CcSwitchReadError("schema_incompatible"), { stack: "SECRET STACK CANARY" }); } },
    onDiagnostic: (value) => diagnostics.push(value),
    now: () => 1000,
  });
  const text = await skill({ ccswitchAction: "overview", usagePeriod: null });
  assert.match(text, /数据结构.*不兼容/);
  assert.doesNotMatch(text, /SECRET|STACK|CANARY/);
  assert.deepEqual(diagnostics, [{
    event: "ccswitch_query", action: "overview", outcome: "schema_incompatible",
    databaseSchemaVersion: null, elapsedBucket: "lt_100ms", rowCountBucket: "0",
  }]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /SECRET|STACK|CANARY/);
});

test("only the formatted response reaches a persisted outbox row", async () => {
  const result = {
    action: "providers", rows: [{ appLabel: "claude", name: "Primary", current: true, category: null, providerType: null, endpointOrigin: "https://api.example.com" }], omitted: 0,
  };
  const skill = createCcSwitchSkill({ reader: { read: async () => result } });
  const text = await skill({ ccswitchAction: "providers", usagePeriod: null });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ccswitch-outbox-test-"));
  const store = new Store(path.join(directory, "gateway.sqlite"));
  try {
    store.enqueueOutbox("ccswitch-test", `[Gateway | - | - | -]\n${text}`);
    const persisted = store.nextOutbox().text;
    assert.match(persisted, /Primary/);
    assert.doesNotMatch(persisted, /settings_config|provider-a|SECRET CANARY/);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

