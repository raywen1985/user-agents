import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { CcSwitchReader } from "../src/ccswitch-reader.mjs";
import { readCcSwitchDatabase } from "../src/ccswitch-worker.mjs";

const NOW = Date.parse("2026-10-14T02:00:00.000Z");

function createFixture({ wal = false, omitCreatedIndex = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ccswitch-reader-test-"));
  const root = path.join(directory, ".cc-switch");
  fs.mkdirSync(root);
  const databasePath = path.join(root, "cc-switch.db");
  const db = new DatabaseSync(databasePath);
  if (wal) db.exec("PRAGMA journal_mode=WAL");
  db.exec(`
    PRAGMA user_version=18;
    CREATE TABLE providers (
      id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL,
      settings_config TEXT NOT NULL, category TEXT, created_at INTEGER,
      sort_index INTEGER, notes TEXT, icon TEXT, icon_color TEXT,
      meta TEXT NOT NULL DEFAULT '{}', is_current BOOLEAN NOT NULL,
      in_failover_queue BOOLEAN NOT NULL DEFAULT 0, cost_multiplier TEXT NOT NULL DEFAULT '1',
      limit_daily_usd TEXT, limit_monthly_usd TEXT, provider_type TEXT,
      PRIMARY KEY(id, app_type)
    );
    CREATE TABLE provider_health (
      provider_id TEXT NOT NULL, app_type TEXT NOT NULL, is_healthy INTEGER NOT NULL,
      consecutive_failures INTEGER NOT NULL, last_success_at TEXT, last_failure_at TEXT,
      last_error TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(provider_id, app_type)
    );
    CREATE TABLE proxy_config (
      app_type TEXT PRIMARY KEY, proxy_enabled INTEGER NOT NULL, listen_address TEXT NOT NULL,
      listen_port INTEGER NOT NULL, enable_logging INTEGER NOT NULL, enabled INTEGER NOT NULL,
      auto_failover_enabled INTEGER NOT NULL, max_retries INTEGER NOT NULL DEFAULT 2,
      streaming_first_byte_timeout INTEGER NOT NULL DEFAULT 1,
      streaming_idle_timeout INTEGER NOT NULL DEFAULT 1, non_streaming_timeout INTEGER NOT NULL DEFAULT 1,
      circuit_failure_threshold INTEGER NOT NULL DEFAULT 1, circuit_success_threshold INTEGER NOT NULL DEFAULT 1,
      circuit_timeout_seconds INTEGER NOT NULL DEFAULT 1, circuit_error_rate_threshold REAL NOT NULL DEFAULT 1,
      circuit_min_requests INTEGER NOT NULL DEFAULT 1, default_cost_multiplier TEXT NOT NULL DEFAULT '1',
      pricing_model_source TEXT NOT NULL DEFAULT '', live_takeover_active INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE proxy_request_logs (
      request_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, app_type TEXT NOT NULL,
      model TEXT NOT NULL, request_model TEXT, pricing_model TEXT,
      input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL, cache_creation_tokens INTEGER NOT NULL,
      input_token_semantics INTEGER NOT NULL, input_cost_usd TEXT NOT NULL DEFAULT '0',
      output_cost_usd TEXT NOT NULL DEFAULT '0', cache_read_cost_usd TEXT NOT NULL DEFAULT '0',
      cache_creation_cost_usd TEXT NOT NULL DEFAULT '0', total_cost_usd TEXT NOT NULL,
      latency_ms INTEGER NOT NULL, first_token_ms INTEGER, duration_ms INTEGER,
      status_code INTEGER NOT NULL, error_message TEXT, session_id TEXT,
      provider_type TEXT, is_streaming INTEGER NOT NULL DEFAULT 0,
      cost_multiplier TEXT NOT NULL DEFAULT '1', created_at INTEGER NOT NULL,
      data_source TEXT NOT NULL DEFAULT 'proxy'
    );
    CREATE TABLE usage_daily_rollups (
      date TEXT NOT NULL, app_type TEXT NOT NULL, provider_id TEXT NOT NULL,
      model TEXT NOT NULL, request_model TEXT NOT NULL, pricing_model TEXT NOT NULL,
      request_count INTEGER NOT NULL, success_count INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL, cache_creation_tokens INTEGER NOT NULL,
      total_cost_usd TEXT NOT NULL, avg_latency_ms INTEGER NOT NULL,
      input_token_semantics INTEGER NOT NULL,
      PRIMARY KEY(date, app_type, provider_id, model, request_model, pricing_model)
    );
  `);
  if (!omitCreatedIndex) db.exec("CREATE INDEX idx_request_logs_created_at ON proxy_request_logs(created_at)");
  const insertProvider = db.prepare("INSERT INTO providers (id,app_type,name,settings_config,category,sort_index,is_current,provider_type) VALUES (?,?,?,?,?,?,?,?)");
  insertProvider.run("provider-a", "claude", "TOKEN ABC", JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.example.com/private-secret?token=CANARY" } }), "official", 1, 1, "anthropic");
  insertProvider.run("provider-b", "codex", "Codex Public", "model_provider='x'", null, null, 1, null);
  db.prepare("INSERT INTO provider_health VALUES (?,?,?,?,?,?,?,?)").run(
    "provider-a", "claude", 1, 0, "2026-10-14T01:30:00.000000000+00:00", null, "PRIVATE ERROR CANARY", "2026-10-14T01:30:00.000000000+00:00",
  );
  const insertConfig = db.prepare("INSERT INTO proxy_config (app_type,proxy_enabled,listen_address,listen_port,enable_logging,enabled,auto_failover_enabled,live_takeover_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
  insertConfig.run("claude", 1, "127.0.0.1", 15721, 1, 1, 0, 0, "2026-10-14 00:00:00", "2026-10-14 01:30:00");
  insertConfig.run("codex", 1, "0.0.0.0", 15721, 0, 0, 1, 1, "2026-10-14 00:00:00", "2026-10-14 01:30:00");
  db.prepare(`INSERT INTO proxy_request_logs (
    request_id,provider_id,app_type,model,input_tokens,output_tokens,cache_read_tokens,
    cache_creation_tokens,input_token_semantics,total_cost_usd,latency_ms,status_code,created_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "request-1", "provider-a", "claude", "claude-public", 10, 20, 3, 4, 1, "0.1234567", 100, 200, Math.floor(Date.parse("2026-10-14T01:00:00Z") / 1000),
  );
  const insertRollup = db.prepare("INSERT INTO usage_daily_rollups VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  insertRollup.run("2026-10-14", "claude", "provider-a", "ignored-today", "r", "p", 99, 99, 999, 999, 999, 999, "9", 999, 2);
  insertRollup.run("2026-10-13", "codex", "provider-b", "gpt-public", "r", "p", 2, 1, 30, 40, 5, 6, "0.2000004", 200, 2);
  return {
    directory, root, db,
    close() { db.close(); fs.rmSync(directory, { recursive: true, force: true }); },
  };
}

test("reader projects all five read-only actions without secret-bearing fields", async () => {
  const fixture = createFixture();
  try {
    const providers = readCcSwitchDatabase({ root: fixture.root, action: "providers", nowMs: NOW });
    assert.equal(providers.rows.length, 2);
    assert.equal(providers.rows[0].providerName, undefined);
    const claude = providers.rows.find((row) => row.appLabel === "claude");
    assert.equal(claude.name, "不可显示");
    assert.equal(claude.endpointOrigin, "https://api.example.com");
    assert.doesNotMatch(JSON.stringify(providers), /CANARY|private-secret|provider-a/);

    const health = readCcSwitchDatabase({ root: fixture.root, action: "health", nowMs: NOW });
    assert.equal(health.rows.find((row) => row.appLabel === "claude").state, "healthy");
    assert.equal(health.rows.find((row) => row.appLabel === "codex").state, "unknown");
    assert.doesNotMatch(JSON.stringify(health), /PRIVATE ERROR CANARY|provider-a/);

    const routing = readCcSwitchDatabase({ root: fixture.root, action: "routing_status", nowMs: NOW });
    assert.equal(routing.rows.find((row) => row.appLabel === "claude").listenClass, "loopback");
    assert.equal(routing.rows.find((row) => row.appLabel === "codex").listenClass, "non_loopback");

    const overview = readCcSwitchDatabase({ root: fixture.root, action: "overview", nowMs: NOW });
    assert.equal(overview.databaseSchemaVersion, 18);
    assert.equal(overview.applicationVersion, null);

    const parentResult = await new CcSwitchReader({ root: fixture.root }).read("overview", null, NOW);
    assert.equal(parentResult.action, "overview");
  } finally {
    fixture.close();
  }
});

test("usage applies date-level detail precedence and separates input semantics", () => {
  const fixture = createFixture();
  try {
    const today = readCcSwitchDatabase({ root: fixture.root, action: "usage", period: "today", nowMs: NOW });
    assert.equal(today.totals.requests, 1);
    assert.deepEqual(today.totals.inputTokensBySemantics, { 1: 10 });
    assert.equal(today.totals.outputTokens, 20);
    assert.equal(today.totals.estimatedCostUsd, "0.123457");
    assert.deepEqual(today.days, [{ date: "2026-10-14", source: "detail" }]);

    const mixed = readCcSwitchDatabase({ root: fixture.root, action: "usage", period: "last_7_days", nowMs: NOW });
    assert.equal(mixed.totals.requests, 3);
    assert.equal(mixed.totals.successes, 2);
    assert.deepEqual(mixed.totals.inputTokensBySemantics, { 1: 10, 2: 30 });
    assert.equal(mixed.totals.averageLatencyMs, 167);
    assert.equal(mixed.totals.latencyEstimated, true);
    assert.equal(mixed.totals.estimatedCostUsd, "0.323457");
    assert.equal(mixed.coverage, "observed_only");
    assert.equal(mixed.potentiallyIncomplete, true);
  } finally {
    fixture.close();
  }
});

test("usage requires the bounded created-at index", () => {
  const fixture = createFixture({ omitCreatedIndex: true });
  try {
    assert.throws(() => readCcSwitchDatabase({ root: fixture.root, action: "usage", period: "today", nowMs: NOW }), (error) => error.code === "schema_incompatible");
  } finally {
    fixture.close();
  }
});

test("a WAL without an existing SHM fails closed", () => {
  const fixture = createFixture();
  try {
    fs.writeFileSync(path.join(fixture.root, "cc-switch.db-wal"), "not-a-valid-wal");
    assert.throws(() => readCcSwitchDatabase({ root: fixture.root, action: "overview", nowMs: NOW }), (error) => error.code === "read_unavailable");
  } finally {
    fixture.close();
  }
});

test("read-only snapshot observes committed WAL rows while a writer is active", () => {
  const fixture = createFixture({ wal: true });
  try {
    fixture.db.prepare("UPDATE proxy_config SET proxy_enabled=0 WHERE app_type='claude'").run();
    assert.equal(fs.existsSync(path.join(fixture.root, "cc-switch.db-wal")), true);
    assert.equal(fs.existsSync(path.join(fixture.root, "cc-switch.db-shm")), true);
    const result = readCcSwitchDatabase({ root: fixture.root, action: "routing_status", nowMs: NOW });
    assert.equal(result.rows.find((row) => row.appLabel === "claude").proxyEnabled, false);
  } finally {
    fixture.close();
  }
});

test("parent reader terminates an unresponsive worker and exposes only a stable code", async () => {
  class SilentWorker extends EventEmitter {
    terminate() { this.terminated = true; }
  }
  const reader = new CcSwitchReader({ root: "C:\\fixed", timeoutMs: 10, WorkerImpl: SilentWorker });
  await assert.rejects(() => reader.read("overview", null, NOW), (error) => error.code === "read_timeout" && error.message === "read_timeout");
  await assert.rejects(() => reader.read("delete", null, NOW), (error) => error.code === "data_invalid");
});

