import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

const MAX_MAIN = 512 * 1024 * 1024;
const MAX_WAL = 256 * 1024 * 1024;
const MAX_SHM = 64 * 1024 * 1024;
const MAX_TOTAL = 768 * 1024 * 1024;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const ACTIONS = new Set(["overview", "providers", "health", "routing_status", "usage"]);
const PERIODS = new Set(["today", "yesterday", "last_7_days", "last_30_days"]);
const PUBLIC_CODES = new Set([
  "not_installed", "schema_incompatible", "data_invalid", "read_busy",
  "read_failed", "read_unavailable", "resource_limit",
]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function ordinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function byteLength(value) {
  return Buffer.byteLength(String(value), "utf8");
}

function isControlFree(value) {
  return !/[\u0000-\u001f\u007f]/u.test(value);
}

function publicLabel(value, maxBytes = 100) {
  if (typeof value !== "string") return "不可显示";
  const normalized = value.normalize("NFKC").trim();
  const folded = normalized.toLowerCase();
  if (!normalized || byteLength(normalized) > maxBytes || !isControlFree(normalized)
    || /(bearer|token|secret|password|credential|cookie|session|sk-)/i.test(folded)
    || /[a-z0-9_+=-]{24}/i.test(normalized)
    || !/^[\p{L}\p{N} ._:/()@+\-]+$/u.test(normalized)) return "不可显示";
  return normalized;
}

function assertText(value, maxBytes = 200, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && !value) || byteLength(value) > maxBytes) fail("data_invalid");
  return value;
}

function assertSafeInteger(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail("data_invalid");
  return value;
}

function boolValue(value) {
  if (value !== 0 && value !== 1) fail("data_invalid");
  return value === 1;
}

function parseRfc3339(value, nowMs, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || byteLength(value) > 64
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) fail("data_invalid");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed > nowMs + 300000) fail("data_invalid");
  return new Date(parsed).toISOString();
}

function parseSqliteUtcTimestamp(value, nowMs) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) fail("data_invalid");
  const parsed = Date.parse(`${value.replace(" ", "T")}Z`);
  if (!Number.isFinite(parsed) || parsed > nowMs + 300000) fail("data_invalid");
  return new Date(parsed).toISOString();
}

function parseDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail("data_invalid");
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.toISOString().slice(0, 10) !== value) fail("data_invalid");
  return value;
}

function addDays(date, amount) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + amount)).toISOString().slice(0, 10);
}

function shanghaiDate(epochMs) {
  return new Date(epochMs + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

function startOfShanghaiDaySeconds(date) {
  const [year, month, day] = date.split("-").map(Number);
  return Math.floor((Date.UTC(year, month - 1, day) - SHANGHAI_OFFSET_MS) / 1000);
}

function usageRange(period, nowMs) {
  const today = shanghaiDate(nowMs);
  let startDate = today;
  let endDate = today;
  let endSec = Math.floor(nowMs / 1000) + 1;
  if (period === "yesterday") {
    startDate = addDays(today, -1);
    endDate = startDate;
    endSec = startOfShanghaiDaySeconds(today);
  } else if (period === "last_7_days") startDate = addDays(today, -6);
  else if (period === "last_30_days") startDate = addDays(today, -29);
  else if (period !== "today") fail("data_invalid");
  const dates = [];
  for (let date = startDate; date <= endDate; date = addDays(date, 1)) dates.push(date);
  return { today, startDate, endDate, dates, startSec: startOfShanghaiDaySeconds(startDate), endSec };
}

function parseMicros(value) {
  if (typeof value !== "string" || byteLength(value) > 64 || !/^(0|[1-9][0-9]*)(?:\.[0-9]{1,12})?$/.test(value)) fail("data_invalid");
  const [whole, fraction = ""] = value.split(".");
  let micros = BigInt(whole) * 1000000n + BigInt((fraction + "000000").slice(0, 6));
  if ((fraction + "0000000")[6] >= "5") micros += 1n;
  return micros;
}

function formatMicros(value) {
  const whole = value / 1000000n;
  const fraction = String(value % 1000000n).padStart(6, "0");
  return `${whole}.${fraction}`;
}

function toSafeNumber(value) {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) fail("data_invalid");
  return Number(value);
}

function fileIdentity(stat) {
  return `${stat.dev}:${stat.ino}`;
}

function checkedFile(filePath, root, maxSize, missingCode = "read_unavailable") {
  let stat;
  try { stat = fs.lstatSync(filePath); } catch (error) {
    if (error.code === "ENOENT") fail(missingCode);
    fail("read_unavailable");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxSize) fail(stat.size > maxSize ? "resource_limit" : "read_unavailable");
  let canonical;
  try { canonical = fs.realpathSync.native(filePath); } catch { fail("read_unavailable"); }
  if (path.dirname(canonical).toLowerCase() !== root.toLowerCase()) fail("read_unavailable");
  return { path: filePath, canonical, size: stat.size, identity: fileIdentity(stat) };
}

function optionalSidecar(filePath, root, maxSize) {
  if (!fs.existsSync(filePath)) return null;
  return checkedFile(filePath, root, maxSize);
}

function validatePaths(root) {
  let rootStat;
  try { rootStat = fs.lstatSync(root); } catch (error) {
    if (error.code === "ENOENT") fail("not_installed");
    fail("read_unavailable");
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("read_unavailable");
  let canonicalRoot;
  try { canonicalRoot = fs.realpathSync.native(root); } catch { fail("read_unavailable"); }
  const main = checkedFile(path.join(root, "cc-switch.db"), canonicalRoot, MAX_MAIN, "not_installed");
  const wal = optionalSidecar(`${main.path}-wal`, canonicalRoot, MAX_WAL);
  const shm = optionalSidecar(`${main.path}-shm`, canonicalRoot, MAX_SHM);
  if (wal && !shm) fail("read_unavailable");
  if (main.size + (wal?.size || 0) + (shm?.size || 0) > MAX_TOTAL) fail("resource_limit");
  return { root: canonicalRoot, main, wal, shm };
}

function revalidatePaths(snapshot) {
  let sidecarSize = 0;
  for (const [suffix, before, max] of [["-wal", snapshot.wal, MAX_WAL], ["-shm", snapshot.shm, MAX_SHM]]) {
    const filePath = `${snapshot.main.path}${suffix}`;
    if (!before) {
      if (fs.existsSync(filePath)) fail("read_unavailable");
      continue;
    }
    const after = checkedFile(filePath, snapshot.root, max);
    if (after.identity !== before.identity || after.canonical.toLowerCase() !== before.canonical.toLowerCase()) fail("read_unavailable");
    sidecarSize += after.size;
  }
  const main = checkedFile(snapshot.main.path, snapshot.root, MAX_MAIN, "not_installed");
  if (main.identity !== snapshot.main.identity || main.canonical.toLowerCase() !== snapshot.main.canonical.toLowerCase()) fail("read_unavailable");
  if (main.size + sidecarSize > MAX_TOTAL) fail("resource_limit");
}

const SCHEMAS = Object.freeze({
  providers: {
    pk: ["id", "app_type"],
    columns: { id: ["TEXT", 1], app_type: ["TEXT", 1], name: ["TEXT", 1], settings_config: ["TEXT", 1], category: ["TEXT", 0], sort_index: ["INTEGER", 0], is_current: ["BOOLEAN", 1], provider_type: ["TEXT", 0] },
  },
  provider_health: {
    pk: ["provider_id", "app_type"],
    columns: { provider_id: ["TEXT", 1], app_type: ["TEXT", 1], is_healthy: ["INTEGER", 1], consecutive_failures: ["INTEGER", 1], last_success_at: ["TEXT", 0], last_failure_at: ["TEXT", 0], updated_at: ["TEXT", 1] },
  },
  proxy_config: {
    pk: ["app_type"],
    columns: { app_type: ["TEXT", null], proxy_enabled: ["INTEGER", 1], listen_address: ["TEXT", 1], listen_port: ["INTEGER", 1], enable_logging: ["INTEGER", 1], enabled: ["INTEGER", 1], auto_failover_enabled: ["INTEGER", 1], live_takeover_active: ["INTEGER", 1], updated_at: ["TEXT", 1] },
  },
  proxy_request_logs: {
    pk: ["request_id"],
    columns: { request_id: ["TEXT", null], provider_id: ["TEXT", 1], app_type: ["TEXT", 1], model: ["TEXT", 1], input_tokens: ["INTEGER", 1], output_tokens: ["INTEGER", 1], cache_read_tokens: ["INTEGER", 1], cache_creation_tokens: ["INTEGER", 1], input_token_semantics: ["INTEGER", 1], total_cost_usd: ["TEXT", 1], latency_ms: ["INTEGER", 1], status_code: ["INTEGER", 1], created_at: ["INTEGER", 1] },
  },
  usage_daily_rollups: {
    pk: ["date", "app_type", "provider_id", "model", "request_model", "pricing_model"],
    columns: { date: ["TEXT", 1], app_type: ["TEXT", 1], provider_id: ["TEXT", 1], model: ["TEXT", 1], request_model: ["TEXT", 1], pricing_model: ["TEXT", 1], request_count: ["INTEGER", 1], success_count: ["INTEGER", 1], input_tokens: ["INTEGER", 1], output_tokens: ["INTEGER", 1], cache_read_tokens: ["INTEGER", 1], cache_creation_tokens: ["INTEGER", 1], total_cost_usd: ["TEXT", 1], avg_latency_ms: ["INTEGER", 1], input_token_semantics: ["INTEGER", 1] },
  },
});

function tableInfo(db, table) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!exists) fail("schema_incompatible");
  return db.prepare(`PRAGMA table_info(${table})`).all();
}

function validateSchema(db, table) {
  const expected = SCHEMAS[table];
  const rows = tableInfo(db, table);
  const byName = new Map(rows.map((row) => [row.name, row]));
  for (const [name, [type, notnull]] of Object.entries(expected.columns)) {
    const row = byName.get(name);
    if (!row || String(row.type).toUpperCase() !== type || (notnull !== null && row.notnull !== notnull)) fail("schema_incompatible");
  }
  const pk = rows.filter((row) => row.pk > 0).sort((a, b) => a.pk - b.pk).map((row) => row.name);
  if (pk.length !== expected.pk.length || pk.some((name, index) => name !== expected.pk[index])) fail("schema_incompatible");
}

function providerRows(db, includeSettings = false) {
  validateSchema(db, "providers");
  const settings = includeSettings ? ", settings_config" : "";
  const rows = db.prepare(`SELECT id, app_type, name, is_current, category, provider_type, sort_index${settings} FROM providers`).all();
  const keys = new Set();
  const currentByApp = new Map();
  const providers = rows.map((row) => {
    const id = assertText(row.id);
    const appType = assertText(row.app_type, 32);
    const key = `${appType}\u0000${id}`;
    if (keys.has(key)) fail("data_invalid");
    keys.add(key);
    const current = boolValue(row.is_current);
    if (current) currentByApp.set(appType, (currentByApp.get(appType) || 0) + 1);
    if (row.sort_index !== null) assertSafeInteger(row.sort_index, { min: Number.MIN_SAFE_INTEGER });
    if (row.category !== null) assertText(row.category, 100, true);
    if (row.provider_type !== null) assertText(row.provider_type, 100, true);
    return {
      id, appType, appLabel: publicLabel(appType), name: publicLabel(assertText(row.name, 200)),
      current, category: row.category === null ? null : publicLabel(row.category),
      providerType: row.provider_type === null ? null : publicLabel(row.provider_type),
      sortIndex: row.sort_index,
      settingsConfig: includeSettings ? row.settings_config : undefined,
    };
  });
  for (const count of currentByApp.values()) if (count > 1) fail("data_invalid");
  return providers;
}

function safeOrigin(settingsConfig) {
  if (typeof settingsConfig !== "string" || byteLength(settingsConfig) > 256 * 1024) return null;
  let parsed;
  try { parsed = JSON.parse(settingsConfig); } catch { return null; }
  const value = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    && parsed.env && typeof parsed.env === "object" && !Array.isArray(parsed.env)
    ? parsed.env.ANTHROPIC_BASE_URL : null;
  if (typeof value !== "string") return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
  if (publicLabel(url.hostname, 253) === "不可显示") return null;
  const origin = url.origin;
  return byteLength(origin) <= 300 ? origin : null;
}

function readProviders(db) {
  const rows = providerRows(db, true).map((row) => ({
    ...row,
    endpointOrigin: row.appType === "claude" ? safeOrigin(row.settingsConfig) : null,
    settingsConfig: undefined,
  }));
  rows.sort((a, b) => ordinal(a.appLabel, b.appLabel) || ordinal(a.appType, b.appType)
    || Number(b.current) - Number(a.current)
    || (a.sortIndex === null ? 1 : b.sortIndex === null ? -1 : a.sortIndex - b.sortIndex)
    || ordinal(a.name, b.name) || ordinal(a.id, b.id));
  return { action: "providers", rows: rows.slice(0, 50).map(({ id, appType, settingsConfig, ...row }) => row), omitted: Math.max(0, rows.length - 50) };
}

function routingRows(db, nowMs) {
  validateSchema(db, "proxy_config");
  const rows = db.prepare("SELECT app_type, enabled, proxy_enabled, listen_address, listen_port, enable_logging, auto_failover_enabled, live_takeover_active, updated_at FROM proxy_config").all();
  const seen = new Set();
  const projected = rows.map((row) => {
    const appType = assertText(row.app_type, 32);
    if (seen.has(appType)) fail("data_invalid");
    seen.add(appType);
    const address = assertText(row.listen_address, 200).toLowerCase();
    const listenClass = ["localhost", "127.0.0.1", "::1"].includes(address) ? "loopback" : "non_loopback";
    return {
      appType, appLabel: publicLabel(appType), enabled: boolValue(row.enabled),
      proxyEnabled: boolValue(row.proxy_enabled), listenClass,
      listenPort: assertSafeInteger(row.listen_port, { min: 1, max: 65535 }),
      loggingEnabled: boolValue(row.enable_logging), failoverEnabled: boolValue(row.auto_failover_enabled),
      liveTakeoverActive: boolValue(row.live_takeover_active), updatedAt: parseSqliteUtcTimestamp(row.updated_at, nowMs),
    };
  });
  projected.sort((a, b) => ordinal(a.appLabel, b.appLabel) || ordinal(a.appType, b.appType));
  return projected;
}

function readRouting(db, nowMs) {
  const rows = routingRows(db, nowMs);
  return { action: "routing_status", rows: rows.slice(0, 16).map(({ appType, ...row }) => row), omitted: Math.max(0, rows.length - 16) };
}

function readHealth(db, nowMs) {
  const providers = providerRows(db, false);
  validateSchema(db, "provider_health");
  const lookup = new Map(providers.map((provider) => [`${provider.appType}\u0000${provider.id}`, provider]));
  const healthRows = db.prepare("SELECT provider_id, app_type, is_healthy, consecutive_failures, last_success_at, last_failure_at, updated_at FROM provider_health").all();
  const health = new Map();
  for (const row of healthRows) {
    const key = `${assertText(row.app_type, 32)}\u0000${assertText(row.provider_id)}`;
    if (!lookup.has(key) || health.has(key)) fail("data_invalid");
    const updatedAt = parseRfc3339(row.updated_at, nowMs);
    health.set(key, {
      state: boolValue(row.is_healthy) ? "healthy" : "unhealthy",
      consecutiveFailures: assertSafeInteger(row.consecutive_failures),
      lastSuccessAt: parseRfc3339(row.last_success_at, nowMs, true),
      lastFailureAt: parseRfc3339(row.last_failure_at, nowMs, true),
      updatedAt,
      stale: Date.parse(updatedAt) < nowMs - 24 * 60 * 60 * 1000,
    });
  }
  const stateOrder = { unhealthy: 0, unknown: 1, healthy: 2 };
  const rows = providers.map((provider) => {
    const item = health.get(`${provider.appType}\u0000${provider.id}`) || {
      state: "unknown", consecutiveFailures: null, lastSuccessAt: null, lastFailureAt: null, updatedAt: null, stale: false,
    };
    return { ...item, appType: provider.appType, appLabel: provider.appLabel, providerName: provider.name, providerId: provider.id };
  });
  rows.sort((a, b) => stateOrder[a.state] - stateOrder[b.state] || Number(b.stale) - Number(a.stale)
    || ordinal(a.providerName, b.providerName) || ordinal(a.appType, b.appType) || ordinal(a.providerId, b.providerId));
  return { action: "health", rows: rows.slice(0, 50).map(({ appType, providerId, ...row }) => row), omitted: Math.max(0, rows.length - 50) };
}

function optionalFreshness(db, table, column, parser) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!exists) return { state: "unavailable", value: null };
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all();
    const col = rows.find((row) => row.name === column);
    if (!col || String(col.type).toUpperCase() !== (column === "created_at" ? "INTEGER" : "TEXT") || col.notnull !== 1) {
      return { state: "schema_incompatible", value: null };
    }
    const value = db.prepare(`SELECT MAX(${column}) AS value FROM ${table}`).get().value;
    if (value === null) return { state: "empty", value: null };
    return { state: "ok", value: parser(value) };
  } catch {
    return { state: "data_invalid", value: null };
  }
}

function readOverview(db, nowMs, schemaVersion, databaseMtime) {
  const providers = providerRows(db, false);
  const routing = routingRows(db, nowMs);
  const providerApps = new Map();
  for (const provider of providers) {
    const list = providerApps.get(provider.appType) || [];
    list.push(provider);
    providerApps.set(provider.appType, list);
  }
  const routingMap = new Map(routing.map((row) => [row.appType, row]));
  const appTypes = [...new Set([...providerApps.keys(), ...routingMap.keys()])];
  const rows = appTypes.map((appType) => {
    const candidates = providerApps.get(appType) || [];
    const current = candidates.find((provider) => provider.current) || null;
    const route = routingMap.get(appType) || null;
    return {
      appType, appLabel: publicLabel(appType), currentProvider: current?.name || null,
      enabled: route?.enabled ?? null, proxyEnabled: route?.proxyEnabled ?? null,
    };
  }).sort((a, b) => ordinal(a.appLabel, b.appLabel) || ordinal(a.appType, b.appType));
  const latestDetail = optionalFreshness(db, "proxy_request_logs", "created_at", (value) => {
    const seconds = assertSafeInteger(value, { min: 1 });
    const ms = seconds * 1000;
    if (!Number.isSafeInteger(ms) || ms > nowMs + 300000) fail("data_invalid");
    return new Date(ms).toISOString();
  });
  const latestRollup = optionalFreshness(db, "usage_daily_rollups", "date", parseDate);
  return {
    action: "overview", installed: true, applicationVersion: null,
    databaseSchemaVersion: schemaVersion, databaseLastWriteAt: new Date(databaseMtime).toISOString(),
    latestDetail, latestRollup,
    rows: rows.slice(0, 16).map(({ appType, ...row }) => row), omitted: Math.max(0, rows.length - 16),
  };
}

function metric() {
  return { requests: 0n, successes: 0n, input: new Map(), output: 0n, cacheRead: 0n, cacheCreation: 0n, cost: 0n, latencyNumerator: 0n, latencyDenominator: 0n };
}

function addMetric(target, source) {
  target.requests += source.requests;
  target.successes += source.successes;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheCreation += source.cacheCreation;
  target.cost += source.cost;
  target.latencyNumerator += source.latencyNumerator;
  target.latencyDenominator += source.latencyDenominator;
  for (const [semantics, count] of source.input) target.input.set(semantics, (target.input.get(semantics) || 0n) + count);
}

function metricOutput(value, estimatedLatency = false) {
  let averageLatencyMs = null;
  if (value.latencyDenominator) {
    averageLatencyMs = toSafeNumber((2n * value.latencyNumerator + value.latencyDenominator) / (2n * value.latencyDenominator));
  }
  return {
    requests: toSafeNumber(value.requests), successes: toSafeNumber(value.successes),
    successRate: value.requests ? Number((value.successes * 10000n) / value.requests) / 100 : null,
    inputTokensBySemantics: Object.fromEntries([...value.input.entries()].sort((a, b) => a[0] - b[0]).map(([key, count]) => [String(key), toSafeNumber(count)])),
    outputTokens: toSafeNumber(value.output), cacheReadTokens: toSafeNumber(value.cacheRead),
    cacheCreationTokens: toSafeNumber(value.cacheCreation), estimatedCostUsd: formatMicros(value.cost),
    averageLatencyMs, latencyEstimated: estimatedLatency && averageLatencyMs !== null,
  };
}

function checkedUsageCommon(row) {
  const appType = assertText(row.app_type, 32);
  const providerId = assertText(row.provider_id);
  const model = assertText(row.model);
  const semantics = assertSafeInteger(row.input_token_semantics, { max: 2 });
  const output = BigInt(assertSafeInteger(row.output_tokens));
  const cacheRead = BigInt(assertSafeInteger(row.cache_read_tokens));
  const cacheCreation = BigInt(assertSafeInteger(row.cache_creation_tokens));
  const input = BigInt(assertSafeInteger(row.input_tokens));
  return { appType, providerId, model, semantics, output, cacheRead, cacheCreation, input, cost: parseMicros(row.total_cost_usd) };
}

function detailUsage(row, nowMs) {
  assertText(row.request_id);
  const common = checkedUsageCommon(row);
  const createdAt = assertSafeInteger(row.created_at, { min: 1 });
  if (createdAt * 1000 > nowMs + 300000) fail("data_invalid");
  const latency = BigInt(assertSafeInteger(row.latency_ms));
  const status = assertSafeInteger(row.status_code, { min: 100, max: 599 });
  return {
    ...common, date: shanghaiDate(createdAt * 1000), source: "detail",
    value: { requests: 1n, successes: status >= 200 && status <= 399 ? 1n : 0n, input: new Map([[common.semantics, common.input]]), output: common.output, cacheRead: common.cacheRead, cacheCreation: common.cacheCreation, cost: common.cost, latencyNumerator: latency, latencyDenominator: 1n },
  };
}

function rollupUsage(row) {
  const common = checkedUsageCommon(row);
  parseDate(row.date);
  assertText(row.request_model, 200, true);
  assertText(row.pricing_model, 200, true);
  const requests = assertSafeInteger(row.request_count, { min: 1 });
  const successes = assertSafeInteger(row.success_count, { max: requests });
  const latency = assertSafeInteger(row.avg_latency_ms);
  return {
    ...common, date: row.date, source: "rollup",
    value: { requests: BigInt(requests), successes: BigInt(successes), input: new Map([[common.semantics, common.input]]), output: common.output, cacheRead: common.cacheRead, cacheCreation: common.cacheCreation, cost: common.cost, latencyNumerator: BigInt(latency) * BigInt(requests), latencyDenominator: BigInt(requests) },
  };
}

function validateCreatedIndex(db) {
  const index = db.prepare("PRAGMA index_list(proxy_request_logs)").all()
    .find((row) => row.name === "idx_request_logs_created_at");
  const columns = db.prepare("PRAGMA index_info(idx_request_logs_created_at)").all();
  if (!index || columns[0]?.name !== "created_at") fail("schema_incompatible");
}

function readUsage(db, period, nowMs) {
  validateSchema(db, "proxy_request_logs");
  validateSchema(db, "usage_daily_rollups");
  validateCreatedIndex(db);
  const range = usageRange(period, nowMs);
  const detailCount = db.prepare("SELECT COUNT(*) AS count FROM proxy_request_logs WHERE created_at>=? AND created_at<?").get(range.startSec, range.endSec).count;
  const rollupCount = db.prepare("SELECT COUNT(*) AS count FROM usage_daily_rollups WHERE date>=? AND date<=?").get(range.startDate, range.endDate).count;
  if (!Number.isSafeInteger(detailCount) || !Number.isSafeInteger(rollupCount)) fail("data_invalid");
  if (detailCount > 250000 || rollupCount > 100000) fail("resource_limit");
  const detailRows = db.prepare("SELECT request_id, provider_id, app_type, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, input_token_semantics, total_cost_usd, latency_ms, status_code, created_at FROM proxy_request_logs WHERE created_at>=? AND created_at<? ORDER BY created_at, request_id").all(range.startSec, range.endSec).map((row) => detailUsage(row, nowMs));
  const rollupRows = db.prepare("SELECT date, app_type, provider_id, model, request_model, pricing_model, request_count, success_count, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, total_cost_usd, avg_latency_ms, input_token_semantics FROM usage_daily_rollups WHERE date>=? AND date<=? ORDER BY date, app_type, provider_id, model, request_model, pricing_model").all(range.startDate, range.endDate).map(rollupUsage);
  const byDayDetail = Map.groupBy(detailRows, (row) => row.date);
  const byDayRollup = Map.groupBy(rollupRows, (row) => row.date);
  const selected = [];
  const coverage = [];
  let hasRollup = false;
  for (const date of range.dates) {
    const details = byDayDetail.get(date) || [];
    const rollups = byDayRollup.get(date) || [];
    if (details.length) {
      selected.push(...details);
      coverage.push({ date, source: "detail" });
    } else if (date !== range.today && rollups.length) {
      selected.push(...rollups);
      coverage.push({ date, source: "rollup" });
      hasRollup = true;
    } else coverage.push({ date, source: "none" });
  }

  let providers = [];
  try { providers = providerRows(db, false); } catch (error) {
    if (error.code !== "schema_incompatible") throw error;
  }
  const providerLookup = new Map(providers.map((provider) => [`${provider.appType}\u0000${provider.id}`, provider.name]));
  const total = metric();
  const dimensions = { app: new Map(), provider: new Map(), model: new Map() };
  for (const row of selected) {
    addMetric(total, row.value);
    const entries = [
      ["app", row.appType, publicLabel(row.appType), row.appType],
      ["provider", `${row.appType}\u0000${row.providerId}`, providerLookup.get(`${row.appType}\u0000${row.providerId}`) || "未知 Provider", `${row.appType}\u0000${row.providerId}`],
      ["model", row.model, publicLabel(row.model), row.model],
    ];
    for (const [dimension, key, label, stableKey] of entries) {
      let item = dimensions[dimension].get(key);
      if (!item) {
        item = { label, stableKey, value: metric() };
        dimensions[dimension].set(key, item);
      }
      addMetric(item.value, row.value);
    }
  }
  const breakdowns = {};
  for (const [name, values] of Object.entries(dimensions)) {
    const rows = [...values.values()].sort((a, b) => {
      const aTokens = a.value.output + a.value.cacheRead + a.value.cacheCreation;
      const bTokens = b.value.output + b.value.cacheRead + b.value.cacheCreation;
      return bTokens > aTokens ? 1 : bTokens < aTokens ? -1
        : b.value.requests > a.value.requests ? 1 : b.value.requests < a.value.requests ? -1
          : ordinal(a.label, b.label) || ordinal(a.stableKey, b.stableKey);
    });
    breakdowns[name] = { rows: rows.slice(0, 10).map((row) => ({ label: row.label, ...metricOutput(row.value, hasRollup) })), omitted: Math.max(0, rows.length - 10) };
  }
  const warning = coverage.some((day) => day.source === "none")
    || new Set(coverage.map((day) => day.source).filter((source) => source !== "none")).size > 1
    || coverage.some((day) => day.date !== range.today && day.source === "detail");
  return {
    action: "usage", period, coverage: "observed_only", potentiallyIncomplete: warning,
    days: coverage, totals: metricOutput(total, hasRollup), breakdowns,
  };
}

export function readCcSwitchDatabase({ root, action, period = null, nowMs = Date.now() }) {
  if (!ACTIONS.has(action) || (action === "usage" ? !PERIODS.has(period) : period !== null)) fail("data_invalid");
  assertSafeInteger(nowMs, { min: 1 });
  const paths = validatePaths(root);
  const db = new DatabaseSync(paths.main.canonical, { readOnly: true, timeout: 250 });
  let transaction = false;
  try {
    db.enableDefensive?.(true);
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=250; BEGIN");
    transaction = true;
    if (db.prepare("PRAGMA query_only").get().query_only !== 1) fail("read_unavailable");
    const schemaVersion = db.prepare("PRAGMA user_version").get().user_version;
    assertSafeInteger(schemaVersion);
    let result;
    if (action === "overview") result = readOverview(db, nowMs, schemaVersion, fs.statSync(paths.main.canonical).mtimeMs);
    else if (action === "providers") result = readProviders(db);
    else if (action === "health") result = readHealth(db, nowMs);
    else if (action === "routing_status") result = readRouting(db, nowMs);
    else result = readUsage(db, period, nowMs);
    result.databaseSchemaVersion ??= schemaVersion;
    db.exec("COMMIT");
    transaction = false;
    revalidatePaths(paths);
    return result;
  } catch (error) {
    if (transaction) { try { db.exec("ROLLBACK"); } catch {} }
    if (error?.code && PUBLIC_CODES.has(error.code)) throw error;
    if (/busy|locked/i.test(String(error?.message || ""))) fail("read_busy");
    fail("read_failed");
  } finally {
    db.close();
  }
}

if (parentPort) {
  try {
    parentPort.postMessage({ ok: true, result: readCcSwitchDatabase(workerData) });
  } catch (error) {
    parentPort.postMessage({ ok: false, code: PUBLIC_CODES.has(error?.code) ? error.code : "read_failed" });
  }
}

