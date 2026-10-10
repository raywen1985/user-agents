import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isSafeFileChange, isSafeReadCommand } from "../src/executors/codex.mjs";
import { formatSessionMessage } from "../src/format.mjs";
import { normalizeLarkEvent } from "../src/lark.mjs";
import { resolveIntent } from "../src/resolver.mjs";
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
