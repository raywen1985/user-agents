import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Store } from "../src/store.mjs";

function withStore(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lookup-store-"));
  const store = new Store(path.join(root, "gateway.sqlite"));
  return Promise.resolve(run(store, root)).finally(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
}

const project = { alias: "unity", path: "D:\\WA\\unity_asset" };

test("migrates legacy candidate and compact-name state safely", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lookup-store-migrate-"));
  const databasePath = path.join(root, "gateway.sqlite");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, executor TEXT NOT NULL, project_alias TEXT NOT NULL,
      project_path TEXT NOT NULL, native_id TEXT, name TEXT NOT NULL,
      status TEXT NOT NULL, last_summary TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE session_candidate_sets (
      id TEXT PRIMARY KEY, request_message_id TEXT NOT NULL UNIQUE, candidates_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('open', 'consumed', 'expired')),
      selected_index INTEGER, selection_message_id TEXT UNIQUE,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER
    );
    CREATE TABLE session_candidate_message_bindings (
      message_id TEXT PRIMARY KEY, candidate_set_id TEXT NOT NULL, created_at INTEGER NOT NULL
    );
  `);
  const insert = legacy.prepare(`
    INSERT INTO sessions VALUES (?, 'codex', ?, ?, NULL, ?, 'completed', NULL, 1, 1)
  `);
  insert.run("CX-A", "one", "D:\\one", "飞书通知-2");
  insert.run("CX-B", "two", "D:\\two", "飞书通知2");
  insert.run("CX-C", "three", "D:\\three", "Same");
  insert.run("CX-D", "four", "D:\\four", "same");
  legacy.close();

  const store = new Store(databasePath);
  try {
    const columns = new Set(store.db.prepare("PRAGMA table_info(session_candidate_sets)").all().map((row) => row.name));
    assert.equal(columns.has("kind"), true);
    assert.equal(columns.has("parent_set_id"), true);
    const claims = store.db.prepare("SELECT exact_name FROM session_exact_name_claims ORDER BY exact_name").all()
      .map((row) => row.exact_name);
    assert.deepEqual(claims, ["飞书通知-2", "飞书通知2"]);
    const conflict = store.db.prepare(`
      SELECT session_ids_json FROM session_exact_name_claim_conflicts
      WHERE executor='codex' AND exact_name='same'
    `).get();
    assert.deepEqual(JSON.parse(conflict.session_ids_json), ["CX-C", "CX-D"]);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("candidate selection consumes once and creates one imported task", () => withStore((store) => {
  store.acceptInbox({ message_id: "om-original", sender_id: "ou", chat_id: "oc", content: "work" });
  store.beginSessionLookup({
    messageId: "om-original", executor: "codex", project, sessionName: "资源泄漏", content: "继续",
    approvalProfile: { version: 1, grants: ["svn-revert"] },
  });
  const candidate = {
    identity: "codex:11111111-1111-4111-8111-111111111111",
    executor: "codex", nativeId: "11111111-1111-4111-8111-111111111111",
    name: "资源泄漏", nativeName: "资源泄漏", projectAlias: "unity", projectPath: project.path,
  };
  const set = store.createCandidateSet({ messageId: "om-original", candidates: [candidate] });
  store.bindCandidateMessage("om-list", set.id);
  store.acceptInbox({ message_id: "om-choice", sender_id: "ou", chat_id: "oc", reply_to: "om-list", content: "1" });
  const first = store.commitCandidateTask({
    candidateSetId: set.id, selectionMessageId: "om-choice", selectedIndex: 0,
    candidate, executor: "codex", project, name: candidate.name, content: "继续",
  });
  assert.equal(first.ok, true);
  assert.equal(first.session.native_id, candidate.nativeId);
  assert.deepEqual(JSON.parse(first.task.approval_profile_json), { version: 1, grants: ["svn-revert"] });
  assert.equal(store.sessionForMessage("om-original").id, first.session.id);
  assert.equal(store.sessionForMessage("om-choice").id, first.session.id);
  const repeated = store.commitCandidateTask({
    candidateSetId: set.id, selectionMessageId: "om-second", selectedIndex: 0,
    candidate, executor: "codex", project, name: candidate.name, content: "继续",
  });
  assert.equal(repeated.repeated, true);
  assert.equal(store.listQueuedTasks().length, 1);
}));

test("standalone numbers select only one sent candidate set for the same chat and sender", () => withStore((store) => {
  store.acceptInbox({ message_id: "om-original", sender_id: "ou", chat_id: "oc", content: "work" });
  store.beginSessionLookup({ messageId: "om-original", executor: "codex", project, sessionName: "资源泄漏", content: "继续" });
  const set = store.createCandidateSet({ messageId: "om-original", candidates: [{ name: "资源泄漏" }] });

  assert.deepEqual(store.candidateSetForStandaloneNumber({ chatId: "oc", senderId: "ou" }), { kind: "none" });
  store.bindCandidateMessage("om-list", set.id);

  const selected = store.candidateSetForStandaloneNumber({ chatId: "oc", senderId: "ou" });
  assert.equal(selected.kind, "selected");
  assert.equal(selected.binding.id, set.id);
  assert.equal(selected.binding.candidates[0].name, "资源泄漏");
  assert.deepEqual(store.candidateSetForStandaloneNumber({ chatId: "other", senderId: "ou" }), { kind: "none" });
  assert.deepEqual(store.candidateSetForStandaloneNumber({ chatId: "oc", senderId: "other" }), { kind: "none" });
}));

test("new same-scope candidates supersede old lists and standalone numbers reject expired sets", () => withStore((store) => {
  const createSet = (suffix, ttlMs = 600000) => {
    const messageId = `om-original-${suffix}`;
    store.acceptInbox({ message_id: messageId, sender_id: "ou", chat_id: "oc", content: "work" });
    store.beginSessionLookup({ messageId, executor: "codex", project, sessionName: `资源泄漏-${suffix}`, content: "继续" });
    const set = store.createCandidateSet({ messageId, candidates: [{ name: `资源泄漏-${suffix}` }], ttlMs });
    store.bindCandidateMessage(`om-list-${suffix}`, set.id);
    return set;
  };

  const first = createSet("one");
  const second = createSet("two");
  assert.equal(store.candidateSetForStandaloneNumber({ chatId: "oc", senderId: "ou" }).binding.id, second.id);
  assert.equal(store.candidateSetForReply("om-list-one").state, "superseded");

  store.db.prepare("UPDATE session_candidate_sets SET state='consumed' WHERE id=?").run(first.id);
  assert.equal(store.candidateSetForStandaloneNumber({ chatId: "oc", senderId: "ou" }).binding.id, second.id);

  store.db.prepare("UPDATE session_candidate_sets SET expires_at=? WHERE id=?").run(Date.now() - 1, second.id);
  assert.deepEqual(store.candidateSetForStandaloneNumber({ chatId: "oc", senderId: "ou" }), { kind: "none" });
}));

test("named commits reuse native claims but admit only one active task", () => withStore((store) => {
  for (const messageId of ["om-1", "om-2"]) {
    store.acceptInbox({ message_id: messageId, sender_id: "ou", chat_id: "oc", content: "work" });
    store.beginSessionLookup({ messageId, executor: "claude", project, sessionName: "资源检查", content: "work" });
  }
  const candidate = {
    identity: "claude:22222222-2222-4222-8222-222222222222",
    executor: "claude", nativeId: "22222222-2222-4222-8222-222222222222",
    name: "资源检查", projectAlias: "unity", projectPath: project.path,
  };
  const first = store.commitNamedTask({ messageId: "om-1", candidate, executor: "claude", project, name: candidate.name, content: "one" });
  const second = store.commitNamedTask({ messageId: "om-2", candidate, executor: "claude", project, name: candidate.name, content: "two" });
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.reason, "busy");
  assert.equal(store.sessionForMessage("om-1").id, first.session.id);
  assert.equal(store.sessionForMessage("om-2"), null);
  assert.equal(store.listQueuedTasks().length, 1);
}));

test("unresolved name conflicts fence creation", () => withStore((store) => {
  store.db.prepare(`INSERT INTO session_exact_name_claim_conflicts VALUES (?, ?, ?, NULL, ?)`)
    .run("codex", "duplicate", JSON.stringify(["CX-A", "CX-B"]), Date.now());
  store.acceptInbox({ message_id: "om-conflict", sender_id: "ou", chat_id: "oc", content: "work" });
  store.beginSessionLookup({ messageId: "om-conflict", executor: "codex", project, sessionName: "duplicate", content: "work" });
  const result = store.commitNamedTask({
    messageId: "om-conflict", executor: "codex", project, name: "duplicate", content: "work", action: "new",
  });
  assert.deepEqual(result, { ok: false, reason: "name_claim_conflict" });
}));

test("explicit force-new rejects exact names globally but preserves punctuation differences", () => withStore((store) => {
  const first = store.commitNamedTask({
    messageId: "om-force-1", executor: "codex", project,
    name: "Resource-Check", content: "one", action: "new",
  });
  const second = store.commitNamedTask({
    messageId: "om-force-2", executor: "codex", project,
    name: "resource-check", content: "two", action: "new",
  });
  const third = store.commitNamedTask({
    messageId: "om-force-3", executor: "codex", project,
    name: "ResourceCheck", content: "three", action: "new",
  });
  assert.equal(first.ok, true);
  assert.deepEqual(second, { ok: false, reason: "name_in_use", sessionId: first.session.id });
  assert.equal(third.ok, true);
  assert.equal(store.listQueuedTasks().length, 2);
}));

test("exact name claims are global across projects", () => withStore((store) => {
  const first = store.commitNamedTask({
    messageId: "om-global-1", executor: "codex", project,
    name: "global-name", content: "one", action: "new",
  });
  const otherProject = { alias: "client", path: "D:\\ulibs\\client" };
  const second = store.commitNamedTask({
    messageId: "om-global-2", executor: "codex", project: otherProject,
    name: "GLOBAL-NAME", content: "two", action: "new",
  });
  assert.equal(first.ok, true);
  assert.deepEqual(second, { ok: false, reason: "name_in_use", sessionId: first.session.id });
}));

test("queued task and recent context commit together", () => withStore((store) => {
  store.acceptInbox({ message_id: "om-context", sender_id: "ou", chat_id: "oc", content: "work" });
  const result = store.commitNamedTask({
    messageId: "om-context", executor: "claude", project,
    name: "context", content: "work", action: "new",
  });
  assert.equal(result.ok, true);
  const context = store.recentSessionContext({ chatId: "oc", senderId: "ou" });
  assert.equal(context.session_id, result.session.id);
  assert.equal(context.executor, "claude");
  assert.equal(store.recentSessionContext({ chatId: "other", senderId: "ou" }), null);
}));

test("outbox delivery atomically binds the immutable candidate page", () => withStore((store) => {
  store.acceptInbox({ message_id: "om-page", sender_id: "ou", chat_id: "oc", content: "work" });
  store.beginSessionLookup({ messageId: "om-page", executor: "codex", project, sessionName: "page", content: "work" });
  const set = store.createCandidateSet({ messageId: "om-page", candidates: [{ identity: "one", name: "one" }] });
  store.enqueueOutbox("page-list", "choices", null, { candidateSetId: set.id, candidatePageId: set.page.id });
  const outbox = store.nextOutbox();
  assert.equal(store.completeOutboxDelivery(outbox.id, "om-remote"), true);
  const binding = store.candidateSetForReply("om-remote");
  assert.equal(binding.id, set.id);
  assert.equal(binding.page_id, set.page.id);
  assert.equal(binding.candidates[0].identity, "one");
  assert.equal(store.nextOutbox(), null);
}));

test("outbox delivery binds an approval prompt to exactly one pending request", () => withStore((store) => {
  const session = store.createSession({ executor: "codex", projectAlias: project.alias, projectPath: project.path, name: "approval" });
  const task = store.createTask({ sessionId: session.id, messageId: "om-task", action: "new", content: "work" });
  store.updateTask(task.id, "running");
  const approval = store.createApproval({
    sessionId: session.id, taskId: task.id, description: "revert",
    operationClass: "svn-revert", grantEligible: true,
  });
  store.enqueueOutbox("approval-prompt", "prompt", session.id, { approvalId: approval.id });
  const outbox = store.nextOutbox();
  assert.equal(store.completeOutboxDelivery(outbox.id, "om-approval-prompt"), true);
  assert.equal(store.approvalForMessage("om-approval-prompt").id, approval.id);
  assert.equal(store.approvalForMessage("om-other"), null);
}));

test("root candidate state, first page, inbox state, and outbox are committed together", () => withStore((store) => {
  store.acceptInbox({ message_id: "om-atomic", sender_id: "ou", chat_id: "oc", content: "work" });
  store.beginSessionLookup({ messageId: "om-atomic", executor: "codex", project, sessionName: "missing", content: "work" });
  const set = store.createCandidateSet({
    messageId: "om-atomic",
    kind: "session-choice",
    candidates: [{ kind: "create-new", identity: "action:create-new" }],
    outbox: { dedupeKey: "candidate-atomic", text: "choices" },
  });
  const row = store.nextOutbox();
  assert.equal(row.candidate_set_id, set.id);
  assert.equal(row.candidate_page_id, set.page.id);
  assert.equal(store.db.prepare("SELECT status FROM inbox WHERE message_id='om-atomic'").get().status, "waiting_selection");
}));

test("candidate pages are immutable and fuzzy pages retain create-new", () => withStore((store) => {
  store.acceptInbox({ message_id: "om-pages", sender_id: "ou", chat_id: "oc", content: "work" });
  store.beginSessionLookup({ messageId: "om-pages", executor: "codex", project, sessionName: "missing", content: "work" });
  const candidates = Array.from({ length: 12 }, (_, index) => ({
    kind: "existing-session", identity: `session:${index}`, candidate: { name: `session-${index}` },
  }));
  candidates.push({ kind: "create-new", identity: "action:create-new" });
  const set = store.createCandidateSet({ messageId: "om-pages", candidates, kind: "session-choice" });
  assert.equal(set.candidates.length, 10);
  assert.equal(set.candidates.at(-1).kind, "create-new");
  store.bindCandidateMessage("om-page-one", set.id, set.page.id);

  const moved = store.navigateCandidatePage({ candidateSetId: set.id, direction: "next" });
  assert.equal(moved.ok, true);
  assert.equal(moved.set.page.page_number, 1);
  assert.equal(moved.set.candidates.length, 4);
  assert.equal(moved.set.candidates.at(-1).kind, "create-new");
  assert.equal(store.candidateSetForReply("om-page-one").candidates[0].identity, "session:0");
}));

test("committing a discovered project persists only its authority recipe", () => withStore((store) => {
  const authority = {
    sourceType: "native", provider: "claude",
    nativeId: "88888888-8888-4888-8888-888888888888",
    sourcePath: "C:\\Users\\Administrator\\.claude\\projects\\opaque\\session.jsonl",
  };
  const discovered = { ...project, authorities: [authority] };
  const result = store.commitNamedTask({
    messageId: "om-authority", executor: "claude", project: discovered,
    name: "discovered", content: "work", action: "new",
  });
  const stored = store.getProjectAuthority(result.session.id);
  assert.equal(stored.source_type, "native");
  assert.equal(stored.provider, "claude");
  assert.equal(stored.native_id, authority.nativeId);
  assert.equal(stored.project_path, project.path);
}));
