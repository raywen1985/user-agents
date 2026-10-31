import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMessageCoordinator } from "../src/message-coordinator.mjs";
import { Store } from "../src/store.mjs";

const project = { alias: "agents", path: "C:\\Users\\Administrator\\.agents", aliases: [] };
const config = {
  projects: [project],
  projectAliases: new Map([[project.alias, project]]),
  gateway: { recentSessionLimit: 20 },
};

function withStore(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "message-coordinator-"));
  const store = new Store(path.join(root, "gateway.sqlite"));
  return Promise.resolve(run(store)).finally(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
}

function message(content, overrides = {}) {
  return {
    message_id: "om-command",
    chat_id: "oc-chat",
    sender_id: "ou-user",
    reply_to: null,
    content,
    ...overrides,
  };
}

function coordinator(store, intent = { action: "help" }) {
  let calls = 0;
  const value = createMessageCoordinator({
    config,
    store,
    router: { async route() { calls += 1; return { ...intent }; } },
    internalSkills: { descriptors: () => [], has: () => false },
  });
  return { ...value, get calls() { return calls; } };
}

test("standard session commands are split deterministically before the router", () => withStore(async (store) => {
  const subject = coordinator(store);
  const resolved = await subject.coordinate(message("codex 飞书通知 方案A"));
  assert.equal(subject.calls, 0);
  assert.deepEqual({ type: resolved.type, executor: resolved.executor, name: resolved.name, content: resolved.content }, {
    type: "lookup", executor: "codex", name: "飞书通知", content: "方案A",
  });
}));

test("reported Claude list request bypasses the router and does not return project overview", () => withStore(async (store) => {
  const subject = coordinator(store);
  const result = await subject.coordinate(message("列出所有claudecode会话"));
  assert.equal(subject.calls, 0);
  assert.deepEqual(result, { type: "internal_skill", skillName: "list_agent_sessions", overviewExecutor: "claude" });
}));

test("exact typed SVN restore command carries a task-scoped approval profile", () => withStore(async (store) => {
  const subject = coordinator(store);
  const resolved = await subject.coordinate(message("codex TTTT 还原svn所有修改", { message_type: "text" }));
  assert.equal(subject.calls, 0);
  assert.deepEqual(resolved.approvalProfile, { version: 1, grants: ["svn-status", "svn-revert"] });
}));

test("approval commands bypass the router and scoped approval requires an exact reply binding", () => withStore(async (store) => {
  const session = store.createSession({ executor: "codex", projectAlias: project.alias, projectPath: project.path, name: "approval" });
  const task = store.createTask({ sessionId: session.id, messageId: "om-task", action: "new", content: "work" });
  store.updateTask(task.id, "running");
  const approval = store.createApproval({
    sessionId: session.id, taskId: task.id, description: "revert",
    operationClass: "svn-revert", grantEligible: true,
  });
  const subject = coordinator(store);
  const direct = await subject.coordinate(message(`批准 ${approval.id}`, { message_id: "om-direct", message_type: "text" }));
  assert.equal(subject.calls, 0);
  assert.equal(direct.type, "approve");

  const unbound = await subject.coordinate(message("全部批准", { message_id: "om-unbound", message_type: "text" }));
  assert.equal(unbound.type, "reply");
  store.enqueueOutbox("approval", "prompt", session.id, { approvalId: approval.id });
  assert.equal(store.completeOutboxDelivery(store.nextOutbox().id, "om-prompt"), true);
  const scoped = await subject.coordinate(message("全部批准", {
    message_id: "om-scope", message_type: "text", reply_to: "om-prompt",
  }));
  assert.equal(scoped.type, "approve_scope");
  assert.equal(scoped.approval.id, approval.id);

  const voice = await subject.coordinate(message("全部批准", { message_id: "om-voice", message_type: "audio" }));
  assert.equal(voice.type, "reply");
}));

test("a conflicting reply session never overrides a standard command", () => withStore(async (store) => {
  const session = store.createSession({
    executor: "codex", projectAlias: project.alias, projectPath: project.path, name: "另一个会话",
  });
  store.bindMessage("om-replied", session.id, "outbound");
  const resolved = await coordinator(store).coordinate(message("codex 飞书通知 方案A", { reply_to: "om-replied" }));
  assert.equal(resolved.type, "reply");
  assert.match(resolved.text, /不一致/);
}));

test("a matching reply session is continued by exact bound identity", () => withStore(async (store) => {
  const session = store.createSession({
    executor: "codex", projectAlias: project.alias, projectPath: project.path, name: "飞书通知",
  });
  store.bindMessage("om-replied", session.id, "outbound");
  const subject = coordinator(store);
  const resolved = await subject.coordinate(message("codex 飞书通知 方案A", { reply_to: "om-replied" }));
  assert.equal(subject.calls, 0);
  assert.equal(resolved.type, "enqueue");
  assert.equal(resolved.session.id, session.id);
  assert.equal(resolved.content, "方案A");
}));

test("explicit new uses reply project context without resuming the replied session", () => withStore(async (store) => {
  const session = store.createSession({
    executor: "codex", projectAlias: project.alias, projectPath: project.path, name: "旧会话",
  });
  store.bindMessage("om-replied", session.id, "outbound");
  const resolved = await coordinator(store).coordinate(message("codex new 新会话 处理新任务", { reply_to: "om-replied" }));
  assert.equal(resolved.type, "lookup_new");
  assert.equal(resolved.name, "新会话");
  assert.equal(resolved.project.path, project.path);
}));

test("targetless continuation uses only the scoped recent context", () => withStore(async (store) => {
  store.acceptInbox(message("first", { message_id: "om-first", message_type: "text" }));
  store.beginSessionLookup({ messageId: "om-first", executor: "codex", project, sessionName: "飞书通知", content: "first" });
  const committed = store.commitNamedTask({
    messageId: "om-first", executor: "codex", project, name: "飞书通知", content: "first", action: "new",
  });
  store.updateTask(committed.task.id, "completed");
  store.updateSession(committed.session.id, { status: "completed" });

  const subject = coordinator(store, { action: "continue", content: "继续检查" });
  const resolved = await subject.coordinate(message("继续检查", { message_id: "om-next" }));
  assert.equal(subject.calls, 1);
  assert.equal(resolved.type, "enqueue");
  assert.equal(resolved.session.id, committed.session.id);

  const other = await subject.coordinate(message("继续检查", {
    message_id: "om-other", chat_id: "oc-other", sender_id: "ou-other",
  }));
  assert.equal(other.type, "lookup_unnamed");
  assert.equal(other.content, "继续检查");
}));

test("candidate operations are resolved before natural-language routing", () => withStore(async (store) => {
  const request = message("codex missing work", { message_id: "om-request", message_type: "text" });
  store.acceptInbox(request);
  store.beginSessionLookup({ messageId: request.message_id, executor: "codex", sessionName: "missing", content: "work" });
  const set = store.createCandidateSet({
    messageId: request.message_id,
    candidates: [{ kind: "create-new", identity: "action:create-new" }],
  });
  store.bindCandidateMessage("om-list", set.id, set.page.id);
  const subject = coordinator(store);
  const resolved = await subject.coordinate(message("1", { message_id: "om-choice", reply_to: "om-list" }));
  assert.equal(subject.calls, 0);
  assert.equal(resolved.type, "candidate_reply");
  assert.equal(resolved.binding.id, set.id);
}));
