import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isSafeFileChange, isSafeReadCommand } from "../src/executors/codex.mjs";
import { formatSessionMessage } from "../src/format.mjs";
import { createInternalSkillRegistry } from "../src/internal-skills.mjs";
import { normalizeLarkEvent } from "../src/lark.mjs";
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

test("session messages always contain executor, project, name and id", () => {
  const text = formatSessionMessage({ executor: "codex", project_alias: "unity_asset", name: "资源检查", id: "CX-1" }, "完成");
  assert.match(text, /Codex \| unity_asset \| 资源检查 \| CX-1/);
});

test("resolver creates a new task only for a registered project", () => {
  const config = testConfig();
  withStore((store) => {
    const result = resolveIntent({
      action: "new", executor: "claude", project_alias: "unity", session_name: "检查资源",
      content: "检查资源引用", needs_clarification: false,
    }, config, store, {});
    assert.equal(result.type, "enqueue");
    assert.equal(result.project.alias, "unity_asset");
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
    }]);
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

test("Codex auto approval permits only project-local non-delete changes", () => {
  const root = "D:\\WA\\unity_asset";
  assert.equal(isSafeFileChange({ type: "fileChange", changes: [{ path: path.join(root, "a.txt"), kind: { type: "update" } }] }, root), true);
  assert.equal(isSafeFileChange({ type: "fileChange", changes: [{ path: path.join(root, "a.txt"), kind: { type: "delete" } }] }, root), false);
  assert.equal(isSafeFileChange({ type: "fileChange", changes: [{ path: "C:\\outside.txt", kind: { type: "add" } }] }, root), false);
});

test("Codex command policy allows simple reads and rejects compound or mutating commands", () => {
  const root = "D:\\WA\\unity_asset";
  assert.equal(isSafeReadCommand({ cwd: root, command: "rg -n TODO Assets" }, root), true);
  assert.equal(isSafeReadCommand({ cwd: root, command: "rg TODO .; Remove-Item x" }, root), false);
  assert.equal(isSafeReadCommand({ cwd: root, command: "git commit -am test" }, root), false);
});
