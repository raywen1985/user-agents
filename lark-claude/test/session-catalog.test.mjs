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
  fs.writeFileSync(path.join(root, "session_index.jsonl"), `${JSON.stringify({ id, thread_name: name, updated_at: "2026-10-16T00:00:00Z" })}\n`);
  const history = new DatabaseSync(path.join(root, "thread_history_1.sqlite"));
  history.exec("CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, status TEXT, started_at INTEGER)");
  history.prepare("INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?)").run(id, "turn-1", 1, status, 100);
  history.close();
  const state = new DatabaseSync(path.join(root, "state_1.sqlite"));
  state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, cwd TEXT, updated_at_ms INTEGER)");
  state.prepare("INSERT INTO threads VALUES (?, ?, ?, ?)").run(id, name, cwd, 200);
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
