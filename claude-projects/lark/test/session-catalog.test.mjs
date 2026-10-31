import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { collectClaudeHistory, collectClaudeHistoryForProject } from "../src/claude-session-history.mjs";
import { buildSessionCatalog, collectCodexHistory, findNamedSession, revalidateGatewaySession, revalidateNativeCandidate } from "../src/session-catalog.mjs";
import { Store } from "../src/store.mjs";

function temporary(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createCodexHistory(root, id, name, cwd, status = "completed") {
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, "thread-writer-locks"), { recursive: true });
  fs.writeFileSync(path.join(root, "session_index.jsonl"), `${JSON.stringify({ id, thread_name: name, updated_at: "2026-10-16T00:00:00Z" })}\n`);
  const history = new DatabaseSync(path.join(root, "thread_history_1.sqlite"));
  history.exec("CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, status TEXT, started_at INTEGER)");
  history.prepare("INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?)").run(id, "turn-1", 1, status, 100);
  history.close();
  const state = new DatabaseSync(path.join(root, "state_1.sqlite"));
  state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, cwd TEXT, updated_at_ms INTEGER, thread_source TEXT, source TEXT, archived INTEGER)");
  state.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, 'user', 'cli', 0)").run(id, name, cwd, 200);
  state.close();
}

test("collects bounded Codex historical metadata and latest turn state", async () => {
  const root = temporary("codex-history-");
  const id = "11111111-1111-4111-8111-111111111111";
  try {
    createCodexHistory(root, id, "资源泄漏排查", "C:\\work");
    const result = await collectCodexHistory({ codexRoot: root });
    assert.equal(result.complete, true);
    assert.equal(result.records[0].nativeId, id);
    assert.equal(result.records[0].name, "资源泄漏排查");
    assert.equal(result.records[0].latestTurn.status, "completed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("archived native threads stay discoverable but cannot pass catalog or final resume checks", async () => {
  const root = temporary("codex-archive-"), id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  try {
    createCodexHistory(root, id, "Archived", fs.realpathSync.native(root));
    const state = new DatabaseSync(path.join(root, "state_1.sqlite"));
    state.prepare("UPDATE threads SET archived=1 WHERE id=?").run(id); state.close();
    const native = await collectCodexHistory({ codexRoot: root });
    assert.equal(native.records[0].archived, true);
    const options = { codexRoot: root, executor: "codex", probe: async ({ locks }) => ({ locks: new Map(locks.map(item => [item.id, { state: "free" }])) }) };
    const catalog = await buildSessionCatalog(options);
    assert.equal(catalog.complete, true); assert.equal(catalog.candidates[0].capability, "archived");
    assert.deepEqual(await revalidateNativeCandidate({ ...catalog.candidates[0], archived: false, capability: "ready" }, options), { ok: false, reason: "archived" });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Gateway-only native references distinguish missing records from incomplete scans", async () => {
  const root = temporary("native-missing-"), store = new Store(path.join(root, "gateway.sqlite"));
  try {
    const project = { alias: "work", path: fs.realpathSync.native(root) };
    const session = store.createSession({ executor: "codex", projectAlias: project.alias, projectPath: project.path,
      nativeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Lost native" });
    store.updateSession(session.id, { status: "completed" });
    for (const complete of [true, false]) {
      const catalog = await buildSessionCatalog({ config: { projects: [project] }, executor: "codex", store,
        collectCodex: async () => ({ complete, records: [] }) });
      assert.equal(catalog.candidates[0].capability, complete ? "native_missing" : "snapshot_incomplete");
    }
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("collects Claude title and verifies project from envelope metadata", async () => {
  const root = temporary("claude-history-");
  const project = { alias: "unity", path: path.join(root, "project") };
  fs.mkdirSync(project.path);
  const encoded = project.path.replace(/[^a-zA-Z0-9]/g, "-");
  const projectHistory = path.join(root, "projects", encoded);
  const id = "22222222-2222-4222-8222-222222222222";
  fs.mkdirSync(path.join(projectHistory, id), { recursive: true });
  fs.writeFileSync(path.join(projectHistory, id, "custom-title.json"), JSON.stringify({ customTitle: "资源泄漏修复" }));
  fs.writeFileSync(path.join(projectHistory, `${id}.jsonl`), [
    JSON.stringify({ type: "custom-title", sessionId: id }),
    JSON.stringify({ type: "user", sessionId: id, cwd: project.path, message: { content: "private" } }),
  ].join("\n"));
  try {
    const result = await collectClaudeHistoryForProject({ claudeRoot: root, project });
    assert.equal(result.complete, true);
    assert.equal(result.records[0].projectVerified, true);
    assert.equal(result.records[0].name, "资源泄漏修复");
    assert.equal(Object.hasOwn(result.records[0], "message"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("catalog merges a gateway session with its native record and fuzzy matches aliases", async () => {
  const root = temporary("session-catalog-");
  const db = path.join(root, "gateway.sqlite");
  const store = new Store(db);
  const projectPath = path.join(root, "project");
  fs.mkdirSync(projectPath);
  const project = { alias: "unity", path: fs.realpathSync.native(projectPath), aliases: [] };
  const config = { projects: [project] };
  const id = "33333333-3333-4333-8333-333333333333";
  try {
    store.createSession({ executor: "codex", projectAlias: "unity", projectPath: project.path, nativeId: id, name: "Gateway Resource" });
    const collectCodex = async () => ({ complete: true, records: [{
      provider: "codex", executor: "codex", nativeId: id, sessionId: id,
      name: "资源泄漏排查", aliases: [], cwd: project.path, updatedAt: 20,
      latestTurn: { status: "completed" }, capability: "ready", busy: false,
    }] });
    const options = {
      config, store, executor: "codex", project, sessionName: "资源泄漏排查",
      collectCodex, collectClaudeOwners: async () => new Set(),
      probe: async ({ locks }) => ({ locks: new Map(locks.map(lock => [lock.id, { state: "free" }])), processes: new Map() }),
    };
    const catalog = await buildSessionCatalog(options);
    assert.equal(catalog.candidates.length, 1);
    assert.deepEqual(new Set(catalog.candidates[0].aliases), new Set(["Gateway Resource", "资源泄漏排查"]));
    const found = await findNamedSession(options);
    assert.equal(found.match.kind, "selected");
    assert.equal(found.match.selected.gatewayId.startsWith("CX-"), true);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("catalog reports provider incompleteness instead of a false no-match", async () => {
  const root = temporary("session-catalog-fail-");
  const store = new Store(path.join(root, "gateway.sqlite"));
  const project = { alias: "unity", path: root, aliases: [] };
  try {
    const result = await findNamedSession({
      config: { projects: [project] }, store, executor: "codex", project,
      sessionName: "missing", collectCodex: async () => ({ complete: false, records: [] }),
    });
    assert.equal(result.complete, false);
    assert.equal(result.match.kind, "none");
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("global Claude discovery finds an unregistered project from transcript cwd", async () => {
  const root = temporary("claude-global-");
  const projectPath = path.join(root, "unregistered", "client");
  fs.mkdirSync(projectPath, { recursive: true });
  const historyRoot = path.join(root, "projects", "opaque-lossy-name");
  const id = "44444444-4444-4444-8444-444444444444";
  fs.mkdirSync(path.join(historyRoot, id), { recursive: true });
  fs.writeFileSync(path.join(historyRoot, id, "custom-title.json"), JSON.stringify({ customTitle: "导入设置优化" }));
  fs.writeFileSync(path.join(historyRoot, `${id}.jsonl`), JSON.stringify({ type: "user", sessionId: id, cwd: projectPath, timestamp: "2026-10-16T00:00:00Z" }));
  try {
    const result = await collectClaudeHistory({ claudeRoot: root, config: { projects: [], excludedRoots: [] } });
    assert.equal(result.complete, true);
    assert.equal(result.records[0].projectPath, fs.realpathSync.native(projectPath));
    assert.equal(result.records[0].name, "导入设置优化");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("catalog keeps a valid Codex cwd outside configured overrides", async () => {
  const root = temporary("codex-unregistered-");
  const projectPath = path.join(root, "project");
  fs.mkdirSync(projectPath);
  const store = new Store(path.join(root, "gateway.sqlite"));
  const id = "55555555-5555-4555-8555-555555555555";
  try {
    const result = await buildSessionCatalog({
      config: { projects: [], excludedRoots: [] }, store, executor: "codex",
      probe: async ({ locks }) => ({ locks: new Map(locks.map(lock => [lock.id, { state: "free" }])), processes: new Map() }),
      collectCodex: async () => ({ complete: true, records: [{
        provider: "codex", executor: "codex", nativeId: id, sessionId: id,
        name: "Unregistered", aliases: [], cwd: projectPath, updatedAt: 10,
        latestTurn: { status: "completed" }, capability: "ready", busy: false,
      }] }),
    });
    assert.equal(result.candidates[0].projectPath, fs.realpathSync.native(projectPath));
    assert.equal(result.candidates[0].capability, "ready");
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("mapped untitled Claude transcript revalidates by exact id and cwd", async () => {
  const root = temporary("claude-mapped-untitled-");
  const rawProjectPath = path.join(root, "project");
  fs.mkdirSync(rawProjectPath);
  const projectPath = fs.realpathSync.native(rawProjectPath);
  const historyRoot = path.join(root, "projects", "opaque");
  const id = "66666666-6666-4666-8666-666666666666";
  fs.mkdirSync(historyRoot, { recursive: true });
  fs.writeFileSync(path.join(historyRoot, `${id}.jsonl`), JSON.stringify({ type: "user", sessionId: id, cwd: projectPath }));
  const store = new Store(path.join(root, "gateway.sqlite"));
  try {
    let session = store.createSession({ executor: "claude", projectAlias: "legacy", projectPath, nativeId: id, name: "Gateway Name" });
    session = store.updateSession(session.id, { status: "completed" });
    const result = await buildSessionCatalog({
      config: { projects: [], excludedRoots: [] }, store, executor: "claude", claudeRoot: root,
      collectClaudeOwners: async () => new Set(),
    });
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].nativeName, null);
    assert.equal((await revalidateNativeCandidate(result.candidates[0], {
      config: { projects: [], excludedRoots: [] }, claudeRoot: root,
      probe: async () => ({ processes: new Map() }),
    })).ok, true);
    const gatewayCheck = await revalidateGatewaySession(session, {
      config: { projects: [], excludedRoots: [] }, store, claudeRoot: root,
      collectClaudeOwners: async () => new Set(),
      probe: async () => ({ processes: new Map() }),
    });
    assert.deepEqual(gatewayCheck, { ok: true });
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("running gateway Claude session resumes its bound native session when idle", async () => {
  const root = temporary("claude-self-busy-");
  const rawProjectPath = path.join(root, "project");
  fs.mkdirSync(rawProjectPath);
  const projectPath = fs.realpathSync.native(rawProjectPath);
  const historyRoot = path.join(root, "projects", "opaque");
  const id = "77777777-7777-4777-8777-777777777777";
  fs.mkdirSync(historyRoot, { recursive: true });
  fs.writeFileSync(path.join(historyRoot, `${id}.jsonl`), JSON.stringify({ type: "user", sessionId: id, cwd: projectPath }));
  const store = new Store(path.join(root, "gateway.sqlite"));
  try {
    let session = store.createSession({ executor: "claude", projectAlias: "legacy", projectPath, nativeId: id, name: "Gateway Name" });
    session = store.updateSession(session.id, { status: "running" });
    const options = {
      config: { projects: [], excludedRoots: [] }, store, claudeRoot: root,
      collectClaudeOwners: async () => new Set(),
      probe: async () => ({ processes: new Map() }),
    };
    const catalog = await buildSessionCatalog({ ...options, executor: "claude" });
    assert.equal(catalog.candidates[0].busy, true);
    assert.deepEqual(await revalidateGatewaySession(session, options), { ok: true });
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("running gateway Claude session stays busy while a live native owner exists", async () => {
  const root = temporary("claude-live-owner-");
  const rawProjectPath = path.join(root, "project");
  fs.mkdirSync(rawProjectPath);
  const projectPath = fs.realpathSync.native(rawProjectPath);
  const historyRoot = path.join(root, "projects", "opaque");
  const id = "99999999-9999-4999-8999-999999999999";
  fs.mkdirSync(historyRoot, { recursive: true });
  fs.writeFileSync(path.join(historyRoot, `${id}.jsonl`), JSON.stringify({ type: "user", sessionId: id, cwd: projectPath }));
  fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(root, "sessions", "owner.json"), JSON.stringify({ sessionId: id, pid: 4321, procStart: "12345678901" }));
  const store = new Store(path.join(root, "gateway.sqlite"));
  try {
    let session = store.createSession({ executor: "claude", projectAlias: "legacy", projectPath, nativeId: id, name: "Gateway Name" });
    session = store.updateSession(session.id, { status: "running" });
    const result = await revalidateGatewaySession(session, {
      config: { projects: [], excludedRoots: [] }, store, claudeRoot: root,
      collectClaudeOwners: async () => new Set(),
      probe: async ({ processes }) => ({ processes: new Map(processes.map((item) => [item.id, { state: "live" }])) }),
    });
    assert.deepEqual(result, { ok: false, reason: "busy" });
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

function runningCodexResumeFixture({
  turnStatus = "completed", lockState = "missing", probeError = null, gatewayStatus = "running",
} = {}) {
  const root = temporary("codex-self-busy-");
  const rawProjectPath = path.join(root, "project");
  fs.mkdirSync(rawProjectPath);
  const projectPath = fs.realpathSync.native(rawProjectPath);
  const id = "88888888-8888-4888-8888-888888888888";
  const store = new Store(path.join(root, "gateway.sqlite"));
  const project = { alias: "unity", path: projectPath, aliases: [] };
  const record = {
    provider: "codex", executor: "codex", nativeId: id, sessionId: id,
    name: "Gateway Resource", aliases: [], cwd: projectPath, updatedAt: 20,
    latestTurn: { status: turnStatus }, capability: "ready", busy: false,
    lockPath: path.join(root, "thread-writer-locks", `${id}.lock`),
  };
  const options = {
    config: { projects: [project] }, store, codexRoot: root,
    collectCodex: async () => ({ complete: true, records: [record] }),
    probe: async ({ locks }) => {
      if (probeError) throw probeError;
      return { locks: new Map(locks.map((item) => [item.id, { state: lockState }])) };
    },
  };
  let session = store.createSession({ executor: "codex", projectAlias: "unity", projectPath, nativeId: id, name: "Gateway Resource" });
  session = store.updateSession(session.id, { status: gatewayStatus });
  return { root, store, options, session };
}

test("running gateway Codex session ignores self-busy and honors native ownership", async () => {
  const scenarios = [
    [{}, { ok: true }],
    [{ lockState: "held" }, { ok: false, reason: "busy" }],
    [{ turnStatus: "inProgress", lockState: "missing" }, { ok: true }],
    [{ turnStatus: "inProgress", lockState: "free" }, { ok: true }],
    [{ turnStatus: "inProgress", lockState: "held" }, { ok: false, reason: "busy" }],
    [{ turnStatus: "inProgress", lockState: "accessDenied" }, { ok: false, reason: "snapshot_incomplete" }],
    [{ turnStatus: "inProgress", lockState: "error" }, { ok: false, reason: "snapshot_incomplete" }],
    [{ turnStatus: "inProgress", probeError: new Error("probe failed") }, { ok: false, reason: "snapshot_incomplete" }],
  ];
  for (const [fixtureOptions, expected] of scenarios) {
    const { root, store, options, session } = runningCodexResumeFixture(fixtureOptions);
    try {
      assert.deepEqual(await revalidateGatewaySession(session, options), expected);
    } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test("Codex catalog treats stale in-progress history according to the writer lock", async () => {
  const scenarios = [
    ["missing", false, "ready", true],
    ["free", false, "ready", true],
    ["held", true, "busy", true],
    ["accessDenied", null, null, false],
    ["error", null, null, false],
  ];
  for (const [lockState, busy, capability, complete] of scenarios) {
    const { root, store, options } = runningCodexResumeFixture({
      turnStatus: "inProgress", lockState, gatewayStatus: "completed",
    });
    try {
      const catalog = await buildSessionCatalog({ ...options, executor: "codex" });
      assert.equal(catalog.complete, complete, lockState);
      if (complete) {
        assert.equal(catalog.candidates[0].busy, busy, lockState);
        assert.equal(catalog.candidates[0].capability, capability, lockState);
      }
    } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test("duplicate gateway mappings to one native id remain an identity conflict", async () => {
  const { root, store, options, session } = runningCodexResumeFixture();
  try {
    store.createSession({ executor: "codex", projectAlias: "unity", projectPath: session.project_path, nativeId: session.native_id, name: "Duplicate" });
    assert.deepEqual(await revalidateGatewaySession(session, options), { ok: false, reason: "identity_conflict" });
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("incomplete Gateway enumeration blocks an otherwise complete lookup", async () => {
  const result = await findNamedSession({
    config: { projects: [], excludedRoots: [] },
    store: { listSessionsBounded: () => ({ records: [], complete: false }) },
    executor: "claude", sessionName: "missing",
    collectClaude: async () => ({ complete: true, records: [] }),
    collectClaudeOwners: async () => new Set(),
  });
  assert.equal(result.complete, false);
  assert.equal(result.match.kind, "none");
});
