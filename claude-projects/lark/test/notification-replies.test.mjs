import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readNotificationBinding, createNotificationReplyHandler } from "../src/notification-replies.mjs";
import { createMessageCoordinator } from "../src/message-coordinator.mjs";
import { createSessionLookupService } from "../src/session-lookup-service.mjs";
import { Store } from "../src/store.mjs";

const nativeId = "11111111-1111-4111-8111-111111111111";
const binding = { version: 1, messageId: "om_notification", executor: "codex", nativeId,
  recipientOpenId: "ou_test", chatId: "oc_test", createdAt: new Date().toISOString() };
const message = (content = "继续检查", overrides = {}) => ({ message_id: "om_reply", reply_to: binding.messageId,
  chat_type: "p2p", sender_type: "user", chat_id: "oc_test", sender_id: "ou_test", message_type: "text", content, ...overrides });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-notification-reply-"));
  const directory = path.join(root, "bindings");
  fs.mkdirSync(directory);
  const file = path.join(directory, `${binding.messageId}.json`);
  fs.writeFileSync(file, JSON.stringify(binding));
  const store = new Store(path.join(root, "gateway.sqlite"));
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, directory, file, store };
}

test("notification records are read across restarts and checked against sender and chat", (t) => {
  const { directory, file } = fixture(t);
  assert.deepEqual(readNotificationBinding(message(), { directory }), { kind: "bound", binding });
  assert.equal(readNotificationBinding(message("继续", { sender_id: "ou_other" }), { directory }).kind, "forbidden");
  assert.equal(readNotificationBinding(message("继续", { chat_id: "oc_other" }), { directory }).kind, "forbidden");
  assert.equal(readNotificationBinding(message("继续", { chat_type: "group" }), { directory }).kind, "forbidden");
  fs.writeFileSync(file, JSON.stringify({ ...binding, chatId: "" }));
  assert.equal(readNotificationBinding(message(), { directory }).kind, "bound");
});

test("notification lookup rejects malformed, oversized and mismatched records", (t) => {
  const { directory, file } = fixture(t);
  for (const value of ["{", " ".repeat(4097), "null", JSON.stringify({ ...binding, nativeId: "not-a-session" }),
    JSON.stringify({ ...binding, messageId: "om_other" }), JSON.stringify({ ...binding, executor: "shell" })]) {
    fs.writeFileSync(file, value);
    assert.equal(readNotificationBinding(message(), { directory }).kind, "invalid");
  }
  assert.equal(readNotificationBinding(message("继续", { reply_to: "../secrets" }), { directory }).kind, "missing");
  assert.equal(readNotificationBinding(message("继续", { reply_to: "om_old" }), { directory }).kind, "missing");
});

function harness(t, overrides = {}) {
  const files = fixture(t);
  const project = { alias: "workspace", path: files.root, authorities: [] };
  const candidate = { executor: "codex", nativeId, name: "Renamed Session", aliases: ["OldTitle"],
    capability: "ready", busy: false, project, projectPath: files.root, projectAlias: project.alias,
    ...overrides.candidate };
  const config = { projects: [project], gateway: { recentSessionLimit: 20 } };
  const queued = [], replies = [];
  let routerCalls = 0;
  const scheduler = { enqueue(task, session) { queued.push({ task, session }); }, drain() {},
    canEnqueue: () => overrides.canEnqueue !== false };
  const findNamedSession = async (options) => {
    assert.equal(options.executor, binding.executor === candidate.executor ? binding.executor : candidate.executor);
    assert.equal(options.sessionName, nativeId);
    return { complete: overrides.complete !== false, candidates: overrides.candidates || [candidate], match: { kind: "none" } };
  };
  const sendGlobal = async (text) => replies.push(text);
  const options = { config, store: files.store, scheduler, findNamedSession, sendGlobal,
    revalidateNativeCandidate: overrides.revalidate || (async () => overrides.checked || { ok: true }), sendSession: async () => {} };
  const service = createSessionLookupService(options);
  const handle = createNotificationReplyHandler({ ...options, queueCommitted: service.queueCommitted });
  const coordinator = createMessageCoordinator({ config, store: files.store,
    notificationBinding: (incoming) => readNotificationBinding(incoming, { directory: files.directory }),
    router: { route() { routerCalls++; throw new Error("notification must not use router"); } } });
  return { ...files, candidate, queued, replies, coordinator, handle, get routerCalls() { return routerCalls; } };
}

test("both providers continue by native ID after renaming and deduplicate repeated delivery", async (t) => {
  for (const executor of ["codex", "claude"]) {
    const h = harness(t, { candidate: { executor } });
    fs.writeFileSync(h.file, JSON.stringify({ ...binding, executor }));
    const incoming = message("检查下这个功能\n保留第二行");
    h.store.acceptInbox(incoming);
    const resolved = await h.coordinator.coordinate(incoming);
    await h.handle(resolved, incoming);
    await h.handle(resolved, incoming);
    assert.equal(h.queued.length, 1);
    assert.equal(h.queued[0].session.executor, executor);
    assert.equal(h.queued[0].session.native_id, nativeId);
    assert.equal(h.queued[0].session.name, "Renamed Session");
    assert.equal(h.queued[0].task.content, incoming.content);
    assert.equal(h.queued[0].task.action, "continue");
    assert.equal(h.store.recentSessionContext({ chatId: "oc_test", senderId: "ou_test" }).session_id, h.queued[0].session.id);
    assert.equal(h.store.sessionForMessage(binding.messageId), null);
    assert.equal(h.routerCalls, 0);
  }
});

test("version 2 project evidence must agree with the current authoritative project", async t => {
  for (const mismatch of [false, true]) {
    const h = harness(t);
    const other = path.join(h.root, 'other'); fs.mkdirSync(other);
    fs.writeFileSync(h.file, JSON.stringify({ ...binding, version: 2, projectPath: mismatch ? other : h.root, projectAlias: 'display-only' }));
    const incoming = message(); h.store.acceptInbox(incoming);
    await h.handle(await h.coordinator.coordinate(incoming), incoming);
    assert.equal(h.queued.length, mismatch ? 0 : 1);
    if (mismatch) assert.match(h.replies[0], /工程不一致/);
  }
});

test("numeric notification reply is never consumed by a standalone candidate list", async (t) => {
  const h = harness(t);
  const request = message("codex missing work", { message_id: "om_request", reply_to: null });
  h.store.acceptInbox(request);
  h.store.beginSessionLookup({ messageId: request.message_id, executor: "codex", sessionName: "missing", content: "work" });
  const set = h.store.createCandidateSet({ messageId: request.message_id,
    candidates: [{ kind: "create-new", identity: "action:create-new" }] });
  h.store.bindCandidateMessage("om_list", set.id, set.page.id);
  const result = await h.coordinator.coordinate(message("1"));
  assert.equal(result.type, "notification_reply");
  assert.equal(result.content, "1");
  assert.equal((await h.coordinator.coordinate(message("1", { reply_to: "om_unknown" }))).type, "reply");
  assert.equal((await h.coordinator.coordinate(message("1", { reply_to: "om_list" }))).type, "candidate_reply");
});

test("distinct native sessions with the same title remain independently resumable", async (t) => {
  const h = harness(t, { candidate: { name: "Same title" } });
  const otherNativeId = "33333333-3333-4333-8333-333333333333";
  const first = h.store.commitNamedTask({ messageId: "om_other", candidate: { executor: "codex", nativeId: otherNativeId },
    executor: "codex", project: h.candidate.project, name: "Same title", content: "prior", action: "continue" });
  h.store.updateTask(first.task.id, "completed");
  h.store.updateSession(first.session.id, { status: "completed" });
  const incoming = message();
  h.store.acceptInbox(incoming);
  await h.handle(await h.coordinator.coordinate(incoming), incoming);
  assert.equal(h.queued.length, 1);
  assert.equal(h.queued[0].session.native_id, nativeId);
  assert.notEqual(h.queued[0].session.id, first.session.id);
  const blocked = h.store.commitNamedTask({ messageId: "om_new", executor: "codex",
    project: h.candidate.project, name: "Same title", content: "new", action: "new" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "name_claim_conflict");
});

test("unknown and wrong-recipient replies cannot fall through to recent session or router", async (t) => {
  const h = harness(t);
  for (const incoming of [message("继续", { reply_to: "om_old" }), message("1", { sender_id: "ou_other" }),
    message("codex new newName task")]) {
    assert.equal((await h.coordinator.coordinate(incoming)).type, "reply");
  }
  assert.equal(h.routerCalls, 0);
});

test("notification continuation reuses its Gateway mapping and preserves native conflicts", async (t) => {
  for (const state of ["completed", "queued", "archived", "conflict"]) {
    const h = harness(t);
    const first = h.store.commitNamedTask({ messageId: "om_prior", candidate: h.candidate,
      executor: "codex", project: h.candidate.project, name: h.candidate.name, content: "prior", action: "continue" });
    h.candidate.gatewayId = first.session.id;
    if (state !== "queued") h.store.updateTask(first.task.id, "completed");
    h.store.updateSession(first.session.id, { status: state === "conflict" ? "completed" : state });
    if (state === "conflict") h.store.db.prepare("INSERT INTO native_session_claim_conflicts VALUES (?, ?, ?, NULL, ?)")
      .run("codex", nativeId, JSON.stringify([first.session.id, "CX-conflict"]), Date.now());
    const incoming = message();
    h.store.acceptInbox(incoming);
    await h.handle(await h.coordinator.coordinate(incoming), incoming);
    assert.equal(h.store.db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 1, state);
    assert.equal(h.queued.length, state === "completed" ? 1 : 0, state);
    if (state === "completed") assert.equal(h.queued[0].session.id, first.session.id);
    else assert.equal(h.replies.length, 1, state);
  }
});

test("a stop fence raised during native revalidation prevents committing the reply", async (t) => {
  const overrides = { candidate: { gatewayId: "CX-stopping" }, canEnqueue: true,
    revalidate: async () => { overrides.canEnqueue = false; return { ok: true }; } };
  const h = harness(t, overrides);
  const incoming = message();
  h.store.acceptInbox(incoming);
  await h.handle(await h.coordinator.coordinate(incoming), incoming);
  assert.equal(h.store.taskForMessage(incoming.message_id), null);
  assert.equal(h.queued.length, 0);
  assert.match(h.replies[0], /正在停止/);
});

test("notification replies cannot be used to approve a native desktop prompt", async (t) => {
  const h = harness(t);
  for (const content of ["批准", "拒绝", "全部批准", "批准 RQ-261026-ABCDEF"]) {
    assert.equal((await h.coordinator.coordinate(message(content))).type, "reply");
  }
  assert.equal(h.queued.length, 0);
});

test("explicit commands must agree with the notification target", async (t) => {
  for (const [content, accepted] of [["codex OldTitle 继续检查", true], [`codex ${nativeId} 继续检查`, true],
    ["claude OldTitle 继续检查", false], ["codex Different 继续检查", false]]) {
    const h = harness(t);
    const incoming = message(content);
    h.store.acceptInbox(incoming);
    await h.handle(await h.coordinator.coordinate(incoming), incoming);
    assert.equal(h.queued.length, accepted ? 1 : 0, content);
    if (accepted) assert.equal(h.queued[0].task.content, "继续检查");
    else assert.match(h.replies[0], /不一致/);
  }
});

test("missing, ambiguous, busy and unverified notification targets do not create replacement sessions", async (t) => {
  for (const overrides of [
    { candidates: [] }, { complete: false }, { candidate: { busy: true } },
    { candidate: { capability: "identity_conflict" } }, { checked: { ok: false, reason: "busy" } },
    { candidate: { gatewayId: "CX-stopping" }, canEnqueue: false },
    { candidates: [{ executor: "codex", nativeId }, { executor: "codex", nativeId }] },
  ]) {
    const h = harness(t, overrides);
    const incoming = message();
    h.store.acceptInbox(incoming);
    await h.handle(await h.coordinator.coordinate(incoming), incoming);
    assert.equal(h.queued.length, 0);
    assert.equal(h.store.listSessions(20).length, 0);
    assert.equal(h.replies.length, 1);
  }
});
