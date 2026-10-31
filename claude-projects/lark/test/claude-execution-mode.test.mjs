import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadClaudeEnvironment, mergeGatewayConfig, validateClaudeExecutionMode } from "../src/config.mjs";
import { ClaudeExecutor } from "../src/executors/claude.mjs";

const nativeId = "11111111-1111-4111-8111-111111111111";
const session = { id: "CL-1", executor: "claude", project_path: os.tmpdir(), name: "worker" };

function worker(options = {}) {
  return new ClaudeExecutor({ executable: "claude.exe", model: "test", timeoutMs: 1000, ...options });
}

test("Claude mode is opt-in, rejects typos, and supports a local rollback", () => {
  assert.equal(validateClaudeExecutionMode(), "restricted");
  assert.equal(validateClaudeExecutionMode("full_access"), "full_access");
  for (const invalid of ["full", "bypassPermissions", "", false, [], {}]) {
    assert.throws(() => worker({ executionMode: invalid }), /Unsupported Claude execution mode/);
  }
  const merged = mergeGatewayConfig({ claudeExecutionMode: "full_access" }, { claudeExecutionMode: "restricted" });
  assert.equal(validateClaudeExecutionMode(merged.claudeExecutionMode), "restricted");
});

for (const resumed of [false, true]) {
  test(`full-access ${resumed ? "resumed" : "new"} worker receives terminal, MCP and settings capabilities`, async () => {
    const calls = [];
    const controller = new AbortController();
    const executor = worker({
      executionMode: "full_access",
      beforeRun: async () => { calls.push("project"); return { ok: true }; },
      beforeResume: async () => { calls.push("resume"); return { ok: true }; },
      runProcessImpl: async (file, args, options) => {
        calls.push("spawn");
        const option = (name) => args[args.indexOf(name) + 1];
        assert.equal(option("--tools"), "default");
        assert.equal(option("--permission-mode"), "bypassPermissions");
        assert.equal(option("--setting-sources"), "user,project,local");
        assert.equal(JSON.parse(option("--settings")).enableAllProjectMcpServers, true);
        assert.equal(option("--system-prompt-snapshot"), "off");
        for (const flag of ["--restricted", "--strict-mcp-config", "--disable-slash-commands", "--fork-session"]) {
          assert.equal(args.includes(flag), false);
        }
        assert.equal(args.includes(resumed ? "--session-id" : "--resume"), false);
        assert.match(option(resumed ? "--resume" : "--session-id"), /^[a-f0-9-]{36}$/i);
        if (resumed) assert.equal(option("--resume"), nativeId);
        assert.equal(options.cwd, session.project_path);
        assert.equal(options.env.LARK_GATEWAY_MANAGED, "1");
        assert.equal(options.signal, controller.signal);
        return { code: 0, stdout: JSON.stringify({ result: "done" }) };
      },
    });
    const result = await executor.run({
      session: { ...session, native_id: resumed ? nativeId : null },
      content: "execute the task", signal: controller.signal,
    });
    assert.deepEqual(calls, resumed ? ["project", "resume", "spawn"] : ["project", "spawn"]);
    assert.equal(result.summary, "done");
    if (resumed) assert.equal(result.nativeId, nativeId);
  });
}

test("full-access workers still stop at failed project or native ownership validation", async () => {
  for (const guard of ["beforeRun", "beforeResume"]) {
    let spawned = false;
    const executor = worker({
      executionMode: "full_access",
      [guard]: async () => ({ ok: false, reason: "busy" }),
      runProcessImpl: async () => { spawned = true; throw new Error("must not run"); },
    });
    await assert.rejects(executor.run({ session: { ...session, native_id: nativeId }, content: "continue" }), { code: "busy" });
    assert.equal(spawned, false);
  }
});

test("restricted fallback retains file-only tools without MCP or skills", async () => {
  const executor = worker({
    runProcessImpl: async (file, args) => {
      for (const flag of ["--restricted", "--strict-mcp-config", "--disable-slash-commands"]) assert.ok(args.includes(flag));
      assert.equal(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
      assert.equal(args[args.indexOf("--tools") + 1], "Read,Edit,Write,Glob,Grep");
      assert.equal(args.includes("--settings"), false);
      return { code: 0, stdout: JSON.stringify({ result: "done" }) };
    },
  });
  await executor.run({ session, content: "inspect" });
});

test("normal worker environment reaches MCP while router environment stays limited", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-mode-env-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const settingsPath = path.join(directory, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ env: {
    MCP_FIXTURE: "configured", ANTHROPIC_FIXTURE: "configured", LARK_GATEWAY_MANAGED: "0",
  } }));
  const inheritedEnv = { PATH: "path", MCP_INHERITED: "inherited", MCP_FIXTURE: "old" };
  const full = loadClaudeEnvironment({ executionMode: "full_access", inheritedEnv, settingsPath });
  assert.equal(full.MCP_INHERITED, "inherited");
  assert.equal(full.MCP_FIXTURE, "configured");
  assert.equal(full.LARK_GATEWAY_MANAGED, "1");
  assert.equal(inheritedEnv.MCP_FIXTURE, "old");
  const router = loadClaudeEnvironment({ inheritedEnv, settingsPath });
  assert.equal(router.PATH, "path");
  assert.equal(router.ANTHROPIC_FIXTURE, "configured");
  assert.equal(router.MCP_INHERITED, undefined);
  assert.equal(router.MCP_FIXTURE, undefined);
  assert.equal(router.LARK_GATEWAY_MANAGED, "1");
});
