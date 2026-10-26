import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isSafeFileChange } from "../src/executors/codex.mjs";
import { formatSessionMessage } from "../src/format.mjs";
import { createInternalSkillRegistry } from "../src/internal-skills.mjs";
import { classifyInboundMessage, normalizeLarkEvent } from "../src/lark.mjs";
import { buildRouterContext, resolveIntent } from "../src/resolver.mjs";
import { Scheduler } from "../src/scheduler.mjs";
import { Store } from "../src/store.mjs";

function withStore(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lark-gateway-test-"));
  const store = new Store(path.join(directory, "test.sqlite"));
  try { return run(store); } finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}

function testConfig() {
  const project = { alias: "unity_asset", path: "D:\\WA\\unity_asset", aliases: ["unity", "unity项目"] };
  return {
    gateway: { recentSessionLimit: 12 },
    projects: [project],
    projectAliases: new Map([["unity_asset", project], ["unity", project], ["unity项目", project]]),
  };
}

test("normalizeLarkEvent preserves the routing fields", () => {
  assert.deepEqual(normalizeLarkEvent({
    message_id: "om_1", sender_id: "ou_1", sender_type: "user", chat_id: "oc_1",
    chat_type: "p2p", message_type: "text", reply_to: "om_0", content: " 继续处理 ",
  }), {
    message_id: "om_1", sender_id: "ou_1", sender_type: "user", chat_id: "oc_1",
    chat_type: "p2p", message_type: "text", reply_to: "om_0", content: "继续处理",
  });
});

test("inbound classifier routes text, plain posts, and audio", () => {
  assert.equal(classifyInboundMessage("text", "继续处理"), "text");
  assert.equal(classifyInboundMessage("post", "统计下今天 token 消耗量"), "text");
  assert.equal(classifyInboundMessage("audio", '<audio key="file_1"/>'), "audio");
});

test("inbound classifier rejects unsupported message types", () => {
  for (const type of ["interactive", "image", "file", "video", "unknown", ""]) {
    assert.equal(classifyInboundMessage(type, "content"), "unsupported");
  }
});

test("post resource markers are rejected conservatively", () => {
  for (const content of [
    "![Image](img_v3_abc123)",
    '请处理这个文件 <file key="file_v3_abc"/>',
    '<folder token="fld_abc"/>',
    '<audio key="file_v3_abc" duration="2s"/>',
    '<video key="file_v3_abc"/>',
    "字面示例：![Image](img_example)",
  ]) {
    assert.equal(classifyInboundMessage("post", content), "post_resource");
  }
});

test("session messages always contain executor, project, name and id", () => {
  const text = formatSessionMessage({ executor: "codex", project_alias: "unity_asset", name: "资源检查", id: "CX-1" }, "完成");
  assert.match(text, /Codex \| unity_asset \| 资源检查 \| CX-1/);
});

test("resolver defers new-task project resolution to discovered metadata", () => {
  const config = testConfig();
  withStore((store) => {
    const result = resolveIntent({
      action: "new", executor: "claude", project_alias: "unity", session_name: "检查资源",
      content: "检查资源引用", needs_clarification: false,
    }, config, store, {});
    assert.equal(result.type, "lookup_new");
    assert.equal(result.project, null);
    assert.equal(result.projectQuery, "unity");
  });
});

test("resolver routes named work to lookup without inventing project or executor", () => {
  const config = testConfig();
  withStore((store) => {
    const result = resolveIntent({
      action: "continue_or_create", executor: null, project_alias: null,
      session_name: "资源泄漏", content: "继续修复第一项", needs_clarification: false,
    }, config, store, {});
    assert.deepEqual(result, {
      type: "lookup", executor: null, project: null,
      projectQuery: null,
      name: "资源泄漏", content: "继续修复第一项",
    });
    const dynamic = resolveIntent({
      action: "continue_or_create", executor: "codex", project_alias: "missing",
      session_name: "资源泄漏", content: "work", needs_clarification: false,
    }, config, store, {});
    assert.equal(dynamic.type, "lookup");
    assert.equal(dynamic.projectQuery, "missing");
  });
});

test("resolver dispatches only an argument-free registered internal skill", () => {
  const config = testConfig();
  const registry = createInternalSkillRegistry({ list_active_agent_sessions: async () => "ok" });
  withStore((store) => {
    const intent = {
      action: "internal_skill", skill_name: "list_active_agent_sessions",
      executor: null, project_alias: null, session_ref: null, session_name: null,
      request_ref: null, content: null, needs_clarification: false, clarification: null,
    };
    assert.deepEqual(resolveIntent(intent, config, store, {}, registry), {
      type: "internal_skill", skillName: "list_active_agent_sessions",
    });
    assert.equal(resolveIntent({ ...intent, skill_name: "invented" }, config, store, {}, registry).type, "unknown");
    assert.equal(resolveIntent({ ...intent, project_alias: "unity" }, config, store, {}, registry).type, "reply");
    assert.equal(resolveIntent({ ...intent, content: "run powershell" }, config, store, {}, registry).type, "reply");
    assert.deepEqual(buildRouterContext(config, store, { reply_to: null }, registry).internal_skills, [{
      name: "list_active_agent_sessions",
      description: "查询当前 PC 上正在工作的 Codex、Claude Code 和网关 Session",
    }, {
      name: "inspect_agent_workspace",
      description: "只读查询本机 Claude Code 和 Codex 的全部、单项目或单 Session 元数据概况",
    }, {
      name: "stop_agent_session",
      description: "使用查询结果中的停止ID精确停止一个正在工作的 Agent Session",
    }, {
      name: "ccswitch",
      description: "只读查询本机 CC Switch 的概况、Provider、健康状态、路由状态和用量",
    }]);
  });
});

test("resolver validates scoped metadata-only Agent workspace overview queries", () => {
  const config = testConfig();
  const registry = createInternalSkillRegistry({ inspect_agent_workspace: async () => "ok" });
  const base = {
    action: "internal_skill",
    skill_name: "inspect_agent_workspace",
    overview_scope: "all",
    overview_executor: null,
    project_query: null,
    session_query: null,
    ccswitch_action: null,
    usage_period: null,
    executor: null,
    project_alias: null,
    session_ref: null,
    session_name: null,
    request_ref: null,
    content: null,
    needs_clarification: false,
    clarification: null,
  };
  withStore((store) => {
    assert.deepEqual(resolveIntent(base, config, store, {}, registry), {
      type: "internal_skill",
      skillName: "inspect_agent_workspace",
      overviewScope: "all",
      overviewExecutor: null,
      projectQuery: null,
      sessionQuery: null,
    });
    assert.deepEqual(resolveIntent({
      ...base,
      overview_scope: "session",
      overview_executor: "claude",
      project_query: "client",
      session_query: "导入设置优化",
    }, config, store, {}, registry), {
      type: "internal_skill",
      skillName: "inspect_agent_workspace",
      overviewScope: "session",
      overviewExecutor: "claude",
      projectQuery: "client",
      sessionQuery: "导入设置优化",
    });
    assert.equal(resolveIntent({ ...base, overview_scope: "all", project_query: "client" }, config, store, {}, registry).type, "reply");
    assert.equal(resolveIntent({ ...base, overview_scope: "project", project_query: null }, config, store, {}, registry).type, "reply");
    assert.equal(resolveIntent({ ...base, executor: "claude" }, config, store, {}, registry).type, "reply");
    assert.equal(resolveIntent({ ...base, ccswitch_action: "overview" }, config, store, {}, registry).type, "reply");
    assert.equal(resolveIntent({ ...base, action: "continue", skill_name: null }, config, store, {}, registry).type, "reply");
  });
});

test("internal skill registry never dispatches unknown names", async () => {
  let calls = 0;
  const registry = createInternalSkillRegistry({
    list_active_agent_sessions: async () => { calls += 1; return "ok"; },
  });
  assert.equal(await registry.dispatch("list_active_agent_sessions", Object.freeze({})), "ok");
  await assert.rejects(() => registry.dispatch("run_shell", {}), /不可用/);
  assert.equal(calls, 1);
});

test("resolver accepts only an exact stop reference for the stop skill", () => {
  const config = testConfig();
  const registry = createInternalSkillRegistry({
    list_active_agent_sessions: async () => "list",
    stop_agent_session: async () => "stop",
  });
  const intent = {
    action: "internal_skill", skill_name: "stop_agent_session",
    executor: null, project_alias: null,
    session_ref: "ST-0123456789ABCDEF0123456789ABCDEF",
    session_name: null, request_ref: null, content: null,
    needs_clarification: false, clarification: null,
  };
  withStore((store) => {
    assert.deepEqual(resolveIntent(intent, config, store, {}, registry), {
      type: "internal_skill",
      skillName: "stop_agent_session",
      sessionRef: intent.session_ref,
    });
    for (const sessionRef of [null, "", "ST-1234", "01234567-89ab-cdef-0123-456789abcdef", "CX-261010-ABCDEF", "1234", "active session"]) {
      assert.equal(resolveIntent({ ...intent, session_ref: sessionRef }, config, store, {}, registry).type, "reply");
    }
    for (const fields of [
      { executor: "codex" }, { project_alias: "unity" }, { session_name: "active" },
      { request_ref: "RQ-1" }, { content: "run powershell" },
    ]) {
      assert.equal(resolveIntent({ ...intent, ...fields }, config, store, {}, registry).type, "reply");
    }
  });
});

test("resolver dispatches only closed CC Switch read actions", () => {
  const config = testConfig();
  const registry = createInternalSkillRegistry({ ccswitch: async () => "ok" });
  const base = {
    action: "internal_skill", skill_name: "ccswitch", ccswitch_action: "usage",
    usage_period: null, executor: null, project_alias: null, session_ref: null,
    session_name: null, request_ref: null, content: null,
    needs_clarification: false, clarification: null,
  };
  withStore((store) => {
    assert.deepEqual(resolveIntent(base, config, store, {}, registry), {
      type: "internal_skill", skillName: "ccswitch", ccswitchAction: "usage", usagePeriod: "today",
    });
    assert.deepEqual(resolveIntent({ ...base, ccswitch_action: "providers" }, config, store, {}, registry), {
      type: "internal_skill", skillName: "ccswitch", ccswitchAction: "providers", usagePeriod: null,
    });
    assert.equal(resolveIntent({ ...base, ccswitch_action: "switch_provider" }, config, store, {}, registry).type, "unknown");
    assert.equal(resolveIntent({ ...base, ccswitch_action: "providers", usage_period: "today" }, config, store, {}, registry).type, "unknown");
    assert.equal(resolveIntent({ ...base, project_alias: "unity" }, config, store, {}, registry).type, "reply");
    assert.equal(resolveIntent({ ...base, content: "select * from providers" }, config, store, {}, registry).type, "reply");
    const rejected = resolveIntent({ ...base, ccswitch_action: "unsupported_mutation" }, config, store, {}, registry);
    assert.equal(rejected.type, "reply");
    assert.match(rejected.text, /仅支持只读查询/);
    const foreign = { ...base, skill_name: "list_active_agent_sessions", ccswitch_action: "overview" };
    assert.equal(resolveIntent(foreign, config, store, {}, registry).type, "reply");
    const mixedAction = { ...base, action: "new", executor: "codex", project_alias: "unity", content: "work" };
    assert.equal(resolveIntent(mixedAction, config, store, {}, registry).type, "reply");
  });
});

test("internal skill descriptors expose only registered fixed skills", () => {
  const registry = createInternalSkillRegistry({});
  assert.deepEqual(registry.descriptors().map((entry) => entry.name), [
    "list_active_agent_sessions",
    "inspect_agent_workspace",
    "stop_agent_session",
    "ccswitch",
  ]);
  assert.equal(registry.has("stop_agent_session"), true);
  assert.equal(registry.has("stop_all_sessions"), false);
});

test("scheduler snapshot uses live queue and approval waiters", () => {
  const scheduler = new Scheduler({ store: {}, executors: {}, onMessage() {} });
  const runningTask = { id: "TK-R", created_at: 20, updated_at: 20 };
  const queuedTask = { id: "TK-Q", created_at: 10, updated_at: 10 };
  scheduler.active.set("CX-R", { abort: new AbortController(), task: runningTask });
  scheduler.queue.push({ task: queuedTask, session: { id: "CX-Q" } });
  scheduler.approvalWaiters.set("RQ-1", { sessionId: "CX-R", taskId: "TK-R", resolve() {} });
  assert.deepEqual(scheduler.activitySnapshot(), [
    { sessionId: "CX-R", taskId: "TK-R", phase: "waiting_approval", taskUpdatedAt: 20, queuePosition: null },
    { sessionId: "CX-Q", taskId: "TK-Q", phase: "queued", taskUpdatedAt: 10, queuePosition: 0 },
  ]);
  assert.equal(Object.isFrozen(scheduler.activitySnapshot()), true);
});

test("scheduler serializes ancestor and descendant project roots", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nested-project-scheduler-"));
  const store = new Store(path.join(directory, "test.sqlite"));
  const releases = [];
  const starts = [];
  const executor = {
    run: ({ session }) => new Promise((resolve) => {
      starts.push(session.project_path);
      releases.push(() => resolve({ nativeId: null, summary: "done" }));
    }),
  };
  const scheduler = new Scheduler({ store, executors: { codex: executor }, onMessage: async () => {}, maxConcurrentProjects: 2 });
  try {
    const parent = store.createSession({ executor: "codex", projectAlias: "parent", projectPath: "D:\\ulibs", name: "parent" });
    const child = store.createSession({ executor: "codex", projectAlias: "child", projectPath: "D:\\ulibs\\client", name: "child" });
    scheduler.enqueue(store.createTask({ sessionId: parent.id, messageId: "nested-1", action: "new", content: "one" }), parent, { defer: true });
    scheduler.enqueue(store.createTask({ sessionId: child.id, messageId: "nested-2", action: "new", content: "two" }), child, { defer: true });
    scheduler.drain();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(starts.length, 1);
    releases.shift()();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(starts.length, 2);
    releases.shift()();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("store enriches only matching bounded scheduler references", () => {
  withStore((store) => {
    const session = store.createSession({ executor: "codex", projectAlias: "unity_asset", projectPath: "D:\\WA\\unity_asset", name: "active" });
    const task = store.createTask({ sessionId: session.id, messageId: "om-active", action: "new", content: "work" });
    const [row] = store.enrichActivitySnapshot([{ sessionId: session.id, taskId: task.id, phase: "running" }]);
    assert.equal(row.sessionId, session.id);
    assert.equal(row.status, "running");
    assert.equal(row.agent, "codex");
    assert.deepEqual(store.enrichActivitySnapshot([{ sessionId: session.id, taskId: "missing", phase: "running" }]), []);
    assert.throws(() => store.enrichActivitySnapshot(new Array(202)), /invalid/);
  });
});

test("reply binding selects the exact session", () => {
  const config = testConfig();
  withStore((store) => {
    const session = store.createSession({ executor: "codex", projectAlias: "unity_asset", projectPath: config.projects[0].path, name: "绑定会话" });
    store.bindMessage("om_reply", session.id, "outbound");
    const result = resolveIntent({ action: "continue", executor: null, project_alias: null, session_ref: null, content: "继续", needs_clarification: false }, config, store, { reply_to: "om_reply" });
    assert.equal(result.session.id, session.id);
  });
});

test("continuation canonicalizes project aliases", () => {
  const config = testConfig();
  withStore((store) => {
    const session = store.createSession({ executor: "codex", projectAlias: "unity_asset", projectPath: config.projects[0].path, name: "别名会话" });
    const result = resolveIntent({ action: "continue", executor: "codex", project_alias: "unity", session_ref: session.id, content: "继续", needs_clarification: false }, config, store, {});
    assert.equal(result.type, "enqueue");
    assert.equal(result.session.id, session.id);
  });
});

test("reference lookup is exact, unbounded by recency, and narrowed by target", () => {
  const config = testConfig();
  withStore((store) => {
    for (let index = 0; index < 105; index += 1) {
      const filler = store.createSession({ executor: "codex", projectAlias: "unity_asset", projectPath: config.projects[0].path, name: `填充会话 ${index}` });
      store.db.prepare("UPDATE sessions SET updated_at=? WHERE id=?").run(1000 + index, filler.id);
    }
    const old = store.createSession({ executor: "codex", projectAlias: "unity_asset", projectPath: config.projects[0].path, name: "很久以前的会话" });
    store.db.prepare("UPDATE sessions SET updated_at=? WHERE id=?").run(1, old.id);
    assert.equal(store.listSessions(100).some((row) => row.id === old.id), false);
    assert.deepEqual(store.findSessions({ reference: old.id }).map((row) => row.id), [old.id]);
    assert.deepEqual(store.findSessions({ reference: old.name }).map((row) => row.id), [old.id]);
    assert.deepEqual(store.findSessions({ reference: old.id.toLowerCase() }).map((row) => row.id), [old.id]);

    const codex = store.createSession({ executor: "codex", projectAlias: "unity_asset", projectPath: config.projects[0].path, name: "重复会话" });
    store.createSession({ executor: "claude", projectAlias: "unity_asset", projectPath: config.projects[0].path, name: "重复会话" });
    assert.equal(store.findSessions({ reference: "重复会话" }).length, 2);
    const byExecutor = resolveIntent({ action: "continue", executor: "codex", project_alias: null, session_ref: "重复会话", content: "继续", needs_clarification: false }, config, store, {});
    assert.equal(byExecutor.session.id, codex.id);
    const ambiguous = resolveIntent({ action: "continue", executor: null, project_alias: null, session_ref: "重复会话", content: "继续", needs_clarification: false }, config, store, {});
    assert.equal(ambiguous.type, "reply");

    const otherPath = "D:\\WA\\other_project";
    const inUnity = store.createSession({ executor: "codex", projectAlias: "unity_asset", projectPath: config.projects[0].path, name: "项目重复" });
    store.createSession({ executor: "codex", projectAlias: "other", projectPath: otherPath, name: "项目重复" });
    const byProject = resolveIntent({ action: "continue", executor: "codex", project_alias: "unity", session_ref: "项目重复", content: "继续", needs_clarification: false }, config, store, {});
    assert.equal(byProject.session.id, inUnity.id);
  });
});

test("approval decisions narrow to the replied session", () => {
  const config = testConfig();
  withStore((store) => {
    const left = store.createSession({ executor: "codex", projectAlias: "unity_asset", projectPath: config.projects[0].path, name: "会话甲" });
    const right = store.createSession({ executor: "codex", projectAlias: "unity_asset", projectPath: config.projects[0].path, name: "会话乙" });
    const leftTask = store.createTask({ sessionId: left.id, messageId: null, action: "new", content: "work" });
    const rightTask = store.createTask({ sessionId: right.id, messageId: null, action: "new", content: "work" });
    const leftApproval = store.createApproval({ sessionId: left.id, taskId: leftTask.id, description: "左" });
    const rightApproval = store.createApproval({ sessionId: right.id, taskId: rightTask.id, description: "右" });
    store.bindMessage("om-left", left.id, "outbound");

    const intent = { action: "approve", request_ref: null, needs_clarification: false };
    assert.equal(resolveIntent(intent, config, store, { reply_to: "om-left" }).approval.id, leftApproval.id);
    assert.equal(resolveIntent({ ...intent, action: "reject", request_ref: rightApproval.id }, config, store, { reply_to: "om-left" }).approval.id, rightApproval.id);
    assert.equal(resolveIntent(intent, config, store, {}).type, "reply");

    const empty = store.createSession({ executor: "codex", projectAlias: "unity_asset", projectPath: config.projects[0].path, name: "会话丙" });
    store.bindMessage("om-empty", empty.id, "outbound");
    const scoped = resolveIntent(intent, config, store, { reply_to: "om-empty" });
    assert.equal(scoped.type, "reply");
    assert.match(scoped.text, /没有待确认请求/);
  });
});

test("Codex auto approval permits only project-local non-delete changes", () => {
  const root = "D:\\WA\\unity_asset";
  assert.equal(isSafeFileChange({ type: "fileChange", changes: [{ path: path.join(root, "a.txt"), kind: { type: "update" } }] }, root), true);
  assert.equal(isSafeFileChange({ type: "fileChange", changes: [{ path: path.join(root, "a.txt"), kind: { type: "delete" } }] }, root), false);
  assert.equal(isSafeFileChange({ type: "fileChange", changes: [{ path: "C:\\outside.txt", kind: { type: "add" } }] }, root), false);
});
