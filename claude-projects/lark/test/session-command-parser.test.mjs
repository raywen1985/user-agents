import assert from "node:assert/strict";
import test from "node:test";
import { parseSessionCommand } from "../src/session-command-parser.mjs";

test("parses the standard session command positionally", () => {
  assert.deepEqual(parseSessionCommand("codex 飞书通知 方案A"), {
    type: "continue-or-create",
    executor: "codex",
    sessionName: "飞书通知",
    content: "方案A",
  });
  assert.deepEqual(parseSessionCommand("  CLAUDE\t导入优化   检查  是否提交  "), {
    type: "continue-or-create",
    executor: "claude",
    sessionName: "导入优化",
    content: "检查  是否提交",
  });
});

test("parses explicit new commands in Chinese and English", () => {
  assert.deepEqual(parseSessionCommand("codex 新建 飞书通知-2 方案A"), {
    type: "create-new",
    executor: "codex",
    sessionName: "飞书通知-2",
    content: "方案A",
  });
  assert.deepEqual(parseSessionCommand("claude NEW import-optimize 检查是否提交"), {
    type: "create-new",
    executor: "claude",
    sessionName: "import-optimize",
    content: "检查是否提交",
  });
});

test("returns deterministic syntax errors for incomplete commands", () => {
  assert.deepEqual(parseSessionCommand("codex"), {
    type: "invalid-command", executor: "codex", reason: "missing_session_and_content",
  });
  assert.deepEqual(parseSessionCommand("codex 飞书通知"), {
    type: "invalid-command", executor: "codex", reason: "missing_content",
  });
  assert.deepEqual(parseSessionCommand("codex new 飞书通知"), {
    type: "invalid-command", executor: "codex", reason: "missing_content",
  });
  assert.deepEqual(parseSessionCommand("codex new"), {
    type: "invalid-command", executor: "codex", reason: "missing_session_and_content",
  });
});

test("recognizes candidate operations without treating ordinary text as a command", () => {
  assert.deepEqual(parseSessionCommand(" 10 "), { type: "number-selection", index: 9 });
  assert.deepEqual(parseSessionCommand("下一页"), { type: "page-navigation", direction: "next" });
  assert.deepEqual(parseSessionCommand("上一页"), { type: "page-navigation", direction: "previous" });
  assert.deepEqual(parseSessionCommand("查询今天 token 消耗"), { type: "not-command" });
  assert.deepEqual(parseSessionCommand("提交 1"), { type: "not-command" });
});
