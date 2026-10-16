import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { runWindowsSessionProbe } from "../src/active-agent-sessions.mjs";
import { terminateClaudeProcess } from "../src/claude-control.mjs";

const identity = { pid: 1234, procStart: "133700000000000000" };

test("Claude termination sends one bounded retained-handle operation", async () => {
  let captured;
  const result = await terminateClaudeProcess({
    ...identity,
    env: { SystemRoot: "C:\\Windows" },
    run: async (file, args, options) => {
      captured = { file, args, options };
      return { code: 0, stderr: "", stdout: JSON.stringify({ locks: [], processes: [], terminate: { state: "terminated", code: null, procStart: identity.procStart } }) };
    },
  });
  assert.equal(captured.file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(JSON.parse(captured.options.input).terminate, { ...identity, waitMs: 5000 });
  assert.deepEqual(result, { state: "terminated", code: null, procStart: identity.procStart });
});

test("Claude termination validates identity and bounded helper outcomes", async () => {
  await assert.rejects(() => terminateClaudeProcess({
    pid: 0, procStart: identity.procStart, env: { SystemRoot: "C:\\Windows" }, run: async () => ({}),
  }), /identity/);
  await assert.rejects(() => terminateClaudeProcess({
    pid: 1, procStart: "bad", env: { SystemRoot: "C:\\Windows" }, run: async () => ({}),
  }), /identity/);
  await assert.rejects(() => terminateClaudeProcess({
    ...identity,
    env: { SystemRoot: "C:\\Windows" },
    run: async () => ({ code: 0, stderr: "", stdout: JSON.stringify({ terminate: { state: "invented" } }) }),
  }), /invalid result/);
});

test("Claude helper alreadyExited remains distinguishable from a successful stop", async () => {
  const result = await terminateClaudeProcess({
    ...identity,
    env: { SystemRoot: "C:\\Windows" },
    run: async () => ({ code: 0, stderr: "", stdout: JSON.stringify({ terminate: { state: "alreadyExited", code: 87, procStart: null } }) }),
  });
  assert.equal(result.state, "alreadyExited");
});

test("real Claude termination stops only a disposable exact process", { skip: process.platform !== "win32" }, async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    windowsHide: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  const exitPromise = once(child, "exit");
  try {
    const probe = await runWindowsSessionProbe({
      locks: [],
      processes: [{ id: "child", pid: child.pid, procStart: "0000000000" }],
    });
    const procStart = probe.processes.get("child").procStart;
    assert.match(procStart, /^\d{10,20}$/);
    const result = await terminateClaudeProcess({ pid: child.pid, procStart });
    assert.equal(result.state, "terminated");
    await exitPromise;
  } finally {
    if (child.exitCode === null) child.kill();
  }
});
