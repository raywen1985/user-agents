import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSessionLookupService, resolveCandidateSelection } from "../src/session-lookup-service.mjs";
import { Store } from "../src/store.mjs";

const project = { alias: "unity", path: "D:\\WA\\unity_asset", aliases: [] };
const config = { projects: [project], projectAliases: new Map([["unity", project]]) };

function candidate(overrides = {}) {
  return {
    identity: "codex:11111111-1111-4111-8111-111111111111",
    provider: "codex",
    executor: "codex",
    nativeId: "11111111-1111-4111-8111-111111111111",
    name: "资源泄漏排查",
    aliases: ["资源泄漏排查"],
    projectAlias: project.alias,
    projectPath: project.path,
    capability: "ready",
    busy: false,
    updatedAt: Date.now(),
    ...overrides,
  };
}

function withHarness(findNamedSession, run, revalidateNativeCandidate = async () => ({ ok: true })) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lookup-service-"));
  const store = new Store(path.join(root, "gateway.sqlite"));
  const queued = [];
  const globalMessages = [];
  const sessionMessages = [];
  let drains = 0;
  const scheduler = {
    enqueue(task, session, options) { queued.push({ task, session, options }); },
    drain() { drains += 1; },
  };
  const service = createSessionLookupService({
    config,
    store,
    scheduler,
    codexRoot: "C:\\codex",
    claudeRoot: "C:\\claude",
    findNamedSession,
    revalidateNativeCandidate,
    sendGlobal: async (text, key, options) => { globalMessages.push({ text, key, options }); },
    sendSession: async (session, text, key) => { sessionMessages.push({ session, text, key }); },
  });
  return Promise.resolve(run({ store, service, queued, globalMessages, sessionMessages, get drains() { return drains; } }))
    .finally(() => {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    });
}

test("a unique safe native match is imported and queued for continuation", () => {
  const selected = candidate();
  return withHarness(async () => ({ complete: true, match: { kind: "selected", selected } }), async (harness) => {
    await harness.service.handleNamedLookup({
      executor: "codex", project, name: "资源泄漏", content: "继续修复",
    }, { message_id: "om-unique" });
    assert.equal(harness.queued.length, 1);
    assert.equal(harness.queued[0].session.native_id, selected.nativeId);
    assert.equal(harness.queued[0].task.action, "continue");
    assert.equal(harness.drains, 1);
    assert.match(harness.sessionMessages[0].text, /执行队列/);
  });
});

test("ambiguous matches persist a bound candidate list and a numbered reply consumes it once", () => {
  const first = candidate();
  const second = candidate({
    identity: "codex:22222222-2222-4222-8222-222222222222",
    nativeId: "22222222-2222-4222-8222-222222222222",
    name: "资源泄漏复查",
  });
  const matches = [{ candidate: first, score: 0.86 }, { candidate: second, score: 0.84 }];
  return withHarness(async () => ({ complete: true, match: { kind: "selection", matches } }), async (harness) => {
    await harness.service.handleNamedLookup({
      executor: "codex", project, name: "资源泄漏", content: "继续修复",
    }, { message_id: "om-ambiguous" });
    assert.equal(harness.queued.length, 0);
    assert.match(harness.globalMessages[0].text, /1\. Codex/);
    assert.match(harness.globalMessages[0].text, /2\. Codex/);
    assert.match(harness.globalMessages[0].text, /飞书的“回复”功能/);
    const candidateSetId = harness.globalMessages[0].options.candidateSetId;
    harness.store.bindCandidateMessage("om-list", candidateSetId);
    const binding = harness.store.candidateSetForReply("om-list");
    await harness.service.handleCandidateReply(binding, { message_id: "om-choice", content: "2" });
    assert.equal(harness.queued.length, 1);
    assert.equal(harness.queued[0].session.native_id, second.nativeId);
    await harness.service.handleCandidateReply(binding, { message_id: "om-choice-2", content: "1" });
    assert.equal(harness.queued.length, 1);
    assert.match(harness.globalMessages.at(-1).text, /已经处理/);
  });
});

test("busy and incomplete searches fail closed without creating a session", async () => {
  await withHarness(async () => ({
    complete: true,
    match: { kind: "selected", selected: candidate({ busy: true, capability: "busy" }) },
  }), async (harness) => {
    await harness.service.handleNamedLookup({ executor: "codex", project, name: "资源泄漏", content: "继续" }, { message_id: "om-busy" });
    assert.equal(harness.store.listSessions(20).length, 0);
    assert.match(harness.globalMessages[0].text, /未创建同名新会话/);
  });
  await withHarness(async () => ({ complete: false, match: { kind: "none", matches: [] } }), async (harness) => {
    await harness.service.handleNamedLookup({ executor: "codex", project, name: "新会话", content: "开始" }, { message_id: "om-incomplete" });
    assert.equal(harness.store.listSessions(20).length, 0);
    assert.match(harness.globalMessages[0].text, /查询不完整/);
  });
});

test("a complete no-match search creates one named session", () => withHarness(
  async () => ({ complete: true, match: { kind: "none", matches: [] } }),
  async (harness) => {
    await harness.service.handleNamedLookup({ executor: "claude", project, name: "全新工作", content: "开始" }, { message_id: "om-new" });
    assert.equal(harness.queued.length, 1);
    assert.equal(harness.queued[0].session.executor, "claude");
    assert.equal(harness.queued[0].session.name, "全新工作");
    assert.equal(harness.queued[0].task.action, "new");
  },
));

test("an unbound bare number has no candidate selection", () => withHarness(
  async () => ({ complete: true, match: { kind: "none", matches: [] } }),
  async ({ store }) => assert.deepEqual(resolveCandidateSelection(store, {
    reply_to: null, content: "1", chat_id: "oc", sender_id: "ou",
  }), { kind: "none" }),
));

test("candidate selection prefers a reply and accepts one standalone numbered list", () => withHarness(
  async () => ({ complete: true, match: { kind: "none", matches: [] } }),
  async ({ store }) => {
    const createSet = (suffix) => {
      const messageId = `om-request-${suffix}`;
      store.acceptInbox({ message_id: messageId, sender_id: "ou", chat_id: "oc", content: "work" });
      store.beginSessionLookup({ messageId, executor: "codex", project, sessionName: suffix, content: "work" });
      const set = store.createCandidateSet({ messageId, candidates: [{ name: suffix }] });
      store.bindCandidateMessage(`om-list-${suffix}`, set.id);
      return set;
    };
    const first = createSet("first");
    const standalone = resolveCandidateSelection(store, {
      reply_to: null, content: " 1 ", chat_id: "oc", sender_id: "ou",
    });
    assert.equal(standalone.kind, "selected");
    assert.equal(standalone.binding.id, first.id);

    const second = createSet("second");
    assert.deepEqual(resolveCandidateSelection(store, {
      reply_to: null, content: "1", chat_id: "oc", sender_id: "ou",
    }), { kind: "ambiguous" });
    const replied = resolveCandidateSelection(store, {
      reply_to: "om-list-first", content: "1", chat_id: "oc", sender_id: "ou",
    });
    assert.equal(replied.kind, "selected");
    assert.equal(replied.binding.id, first.id);
    assert.notEqual(replied.binding.id, second.id);
    assert.deepEqual(resolveCandidateSelection(store, {
      reply_to: null, content: "提交 1", chat_id: "oc", sender_id: "ou",
    }), { kind: "none" });
  },
));

test("an incomplete exact result cannot be resumed", () => withHarness(
  async () => ({ complete: false, match: { kind: "selected", selected: candidate() } }),
  async (harness) => {
    await harness.service.handleNamedLookup({ executor: "codex", project: null, projectQuery: null, name: "资源泄漏", content: "继续" }, { message_id: "om-incomplete-exact" });
    assert.equal(harness.queued.length, 0);
    assert.match(harness.globalMessages[0].text, /查询不完整/);
  },
));

test("a no-match request binds a discovered project choice before creation", () => {
  const discovered = {
    alias: "client#12345678", label: "client", display: "client | D:\\ulibs\\client",
    path: "D:\\ulibs\\client", key: "d:\\ulibs\\client", aliases: ["client"],
    authorities: [{ sourceType: "native", provider: "claude", nativeId: "77777777-7777-4777-8777-777777777777", sourcePath: "C:\\history.jsonl" }],
  };
  const lookup = async () => ({
    complete: true,
    projects: [discovered],
    projectMatch: { kind: "all", projects: [discovered] },
    candidates: [],
    match: { kind: "none", matches: [] },
  });
  return withHarness(lookup, async (harness) => {
    await harness.service.handleNamedLookup({ executor: "claude", project: null, projectQuery: null, name: "全新会话", content: "开始" }, { message_id: "om-project-choice" });
    assert.equal(harness.queued.length, 0);
    assert.match(harness.globalMessages[0].text, /选择用于新建的工程/);
    assert.match(harness.globalMessages[0].text, /飞书的“回复”功能/);
    const candidateSetId = harness.globalMessages[0].options.candidateSetId;
    harness.store.bindCandidateMessage("om-project-list", candidateSetId);
    const binding = harness.store.candidateSetForReply("om-project-list");
    await harness.service.handleCandidateReply(binding, { message_id: "om-project-select", content: "1" });
    assert.equal(harness.queued.length, 1);
    assert.equal(harness.queued[0].session.project_path, discovered.path);
    assert.equal(harness.queued[0].task.action, "new");
    assert.equal(harness.store.getProjectAuthority(harness.queued[0].session.id).native_id,
      discovered.authorities[0].nativeId);
  });
});
