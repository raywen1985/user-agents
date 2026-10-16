import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeExecutor } from "../src/executors/claude.mjs";
import { CodexExecutor } from "../src/executors/codex.mjs";

const nativeId = "11111111-1111-4111-8111-111111111111";
const session = {
  id: "CX-1",
  executor: "codex",
  project_path: "D:\\WA\\unity_asset",
  native_id: nativeId,
  name: "existing",
};

function codexClient(log) {
  let listener = null;
  return {
    items: new Map(),
    async request(method, params) {
      log.push({ method, params });
      if (method === "initialize") return {};
      if (method === "thread/resume") return { thread: { id: params.threadId } };
      if (method === "thread/name/set") return {};
      if (method === "turn/start") {
        setImmediate(() => listener?.({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } }));
        return { turn: { id: "turn-1" } };
      }
      throw new Error(`Unexpected request ${method}`);
    },
    notify(method, params) { log.push({ method, params }); },
    onMessage(callback) { listener = callback; return () => { listener = null; }; },
    close() { log.push({ method: "close" }); },
  };
}

test("Codex guard runs immediately before thread/resume with the exact native ID", async () => {
  const log = [];
  const executor = new CodexExecutor({
    executable: "codex.exe",
    timeoutMs: 1000,
    clientFactory: () => codexClient(log),
    beforeResume: async () => { log.push({ method: "guard" }); return { ok: true }; },
  });
  await executor.run({ session, content: "continue", onApproval: async () => "reject" });
  const methods = log.map((entry) => entry.method);
  assert.equal(methods.indexOf("guard") + 1, methods.indexOf("thread/resume"));
  assert.equal(log.find((entry) => entry.method === "thread/resume").params.threadId, nativeId);
});

test("Codex guard rejection prevents thread/resume", async () => {
  const log = [];
  const executor = new CodexExecutor({
    executable: "codex.exe",
    timeoutMs: 1000,
    clientFactory: () => codexClient(log),
    beforeResume: async () => ({ ok: false, reason: "busy" }),
  });
  await assert.rejects(() => executor.run({ session, content: "continue", onApproval: async () => "reject" }), /正在使用/);
  assert.equal(log.some((entry) => entry.method === "thread/resume"), false);
});

test("Claude guard runs immediately before spawning --resume with the exact native ID", async () => {
  const log = [];
  const executor = new ClaudeExecutor({
    executable: "claude.exe",
    model: "test",
    timeoutMs: 1000,
    beforeResume: async () => { log.push("guard"); return { ok: true }; },
    runProcessImpl: async (file, args) => {
      log.push({ file, args });
      return { code: 0, stdout: JSON.stringify({ session_id: nativeId, result: "done" }), stderr: "" };
    },
  });
  await executor.run({ session: { ...session, executor: "claude", id: "CL-1" }, content: "continue" });
  assert.equal(log[0], "guard");
  assert.equal(log[1].args[log[1].args.indexOf("--resume") + 1], nativeId);
});

test("Claude guard rejection prevents process spawn", async () => {
  let spawned = false;
  const executor = new ClaudeExecutor({
    executable: "claude.exe",
    model: "test",
    timeoutMs: 1000,
    beforeResume: async () => ({ ok: false, reason: "busy" }),
    runProcessImpl: async () => { spawned = true; throw new Error("must not spawn"); },
  });
  await assert.rejects(() => executor.run({ session: { ...session, executor: "claude", id: "CL-1" }, content: "continue" }), /正在使用/);
  assert.equal(spawned, false);
});

test("common project guards run before every new worker starts", async () => {
  const codexLog = [];
  const codex = new CodexExecutor({
    executable: "codex.exe",
    timeoutMs: 1000,
    clientFactory: () => codexClient(codexLog),
    beforeRun: async () => ({ ok: false, reason: "project_unverified" }),
  });
  await assert.rejects(() => codex.run({ session: { ...session, native_id: null }, content: "new", onApproval: async () => "reject" }), /项目目录/);
  assert.equal(codexLog.length, 0);

  let claudeSpawned = false;
  const claude = new ClaudeExecutor({
    executable: "claude.exe", model: "test", timeoutMs: 1000,
    beforeRun: async () => ({ ok: false, reason: "project_unverified" }),
    runProcessImpl: async () => { claudeSpawned = true; throw new Error("must not spawn"); },
  });
  await assert.rejects(() => claude.run({ session: { ...session, executor: "claude", native_id: null }, content: "new" }), /项目目录/);
  assert.equal(claudeSpawned, false);
});
