import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

test("candidate selection consumes once and creates one imported task", () => withStore((store) => {
  store.acceptInbox({ message_id: "om-original", sender_id: "ou", chat_id: "oc", content: "work" });
  store.beginSessionLookup({ messageId: "om-original", executor: "codex", project, sessionName: "资源泄漏", content: "继续" });
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

test("standalone numbers reject ambiguous, expired, and consumed candidate sets", () => withStore((store) => {
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
  assert.deepEqual(store.candidateSetForStandaloneNumber({ chatId: "oc", senderId: "ou" }), { kind: "ambiguous" });

  store.db.prepare("UPDATE session_candidate_sets SET state='consumed' WHERE id=?").run(first.id);
  assert.equal(store.candidateSetForStandaloneNumber({ chatId: "oc", senderId: "ou" }).binding.id, second.id);

  store.db.prepare("UPDATE session_candidate_sets SET expires_at=? WHERE id=?").run(Date.now() - 1, second.id);
  assert.deepEqual(store.candidateSetForStandaloneNumber({ chatId: "oc", senderId: "ou" }), { kind: "none" });
}));

test("named commits reuse native and name claims", () => withStore((store) => {
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
  assert.equal(second.ok, true);
  assert.equal(first.session.id, second.session.id);
  assert.equal(store.sessionForMessage("om-1").id, first.session.id);
  assert.equal(store.sessionForMessage("om-2").id, first.session.id);
  assert.equal(store.listQueuedTasks().length, 2);
}));

test("unresolved name conflicts fence creation", () => withStore((store) => {
  store.db.prepare(`INSERT INTO session_name_claim_conflicts VALUES (?, ?, ?, ?, NULL, ?)`)
    .run("codex", project.path.toLowerCase(), "duplicate", JSON.stringify(["CX-A", "CX-B"]), Date.now());
  store.acceptInbox({ message_id: "om-conflict", sender_id: "ou", chat_id: "oc", content: "work" });
  store.beginSessionLookup({ messageId: "om-conflict", executor: "codex", project, sessionName: "duplicate", content: "work" });
  const result = store.commitNamedTask({
    messageId: "om-conflict", executor: "codex", project, name: "duplicate", content: "work", action: "new",
  });
  assert.deepEqual(result, { ok: false, reason: "name_claim_conflict" });
}));

test("explicit force-new cannot bypass an existing normalized name claim", () => withStore((store) => {
  const first = store.commitNamedTask({
    messageId: "om-force-1", executor: "codex", project,
    name: "Resource Check", content: "one", action: "new",
  });
  const second = store.commitNamedTask({
    messageId: "om-force-2", executor: "codex", project,
    name: "resource-check", content: "two", action: "new",
  });
  assert.equal(first.ok, true);
  assert.deepEqual(second, { ok: false, reason: "name_in_use", sessionId: first.session.id });
  assert.equal(store.listQueuedTasks().length, 1);
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
