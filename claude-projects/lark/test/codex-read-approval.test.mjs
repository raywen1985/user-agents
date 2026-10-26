import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexExecutor } from "../src/executors/codex.mjs";
import { auditPowerShellApproval } from "../src/logger.mjs";

function clientWithApproval(log, params) {
  let listener;
  return {
    items: new Map(),
    async request(method, requestParams) {
      if (method === "initialize") return {};
      if (method === "thread/start") return { thread: { id: "thread-1" } };
      if (method === "thread/name/set") return {};
      if (method === "turn/start") {
        setImmediate(() => listener({ id: 7, method: "item/commandExecution/requestApproval", params }));
        return { turn: { id: "turn-1" } };
      }
      throw new Error(`Unexpected request: ${method}`);
    },
    notify() {},
    onMessage(callback) { listener = callback; return () => {}; },
    respond(id, result) {
      log.push({ id, result });
      setImmediate(() => listener({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } }));
    },
    close() {},
  };
}

const session = { id: "CX-1", project_path: "D:\\WA\\unity_asset", name: "read-test" };

test("accepted read bypasses Lark approval and responds accept", async () => {
  const responses = [];
  let approvals = 0;
  const policy = { classify: async () => true, isProtectedPath: () => false };
  const executor = new CodexExecutor({
    executable: "codex.exe", timeoutMs: 1000, readApprovalPolicy: policy,
    clientFactory: () => clientWithApproval(responses, { command: "read", cwd: session.project_path }),
  });
  await executor.run({ session, content: "read", onApproval: async () => { approvals += 1; return "approve"; } });
  assert.equal(approvals, 0);
  assert.deepEqual(responses, [{ id: 7, result: { decision: "accept" } }]);
});

test("rejected or failed classification requests exactly one Lark approval", async () => {
  for (const classify of [async () => false, async () => { throw new Error("classifier failed"); }]) {
    const responses = [];
    let approvals = 0;
    const policy = { classify, isProtectedPath: () => false };
    const executor = new CodexExecutor({
      executable: "codex.exe", timeoutMs: 1000, readApprovalPolicy: policy,
      clientFactory: () => clientWithApproval(responses, { command: "write", cwd: session.project_path }),
    });
    await executor.run({ session, content: "write", onApproval: async () => { approvals += 1; return "reject"; } });
    assert.equal(approvals, 1);
    assert.deepEqual(responses, [{ id: 7, result: { decision: "decline" } }]);
  }
});

test("structured operation evidence is forwarded to the approval callback", async () => {
  const responses = [];
  let captured;
  const policy = {
    classifyOperation: async () => ({ autoApprove: false, operationClass: "svn-revert", grantEligible: true }),
    isProtectedPath: () => false,
  };
  const executor = new CodexExecutor({
    executable: "codex.exe", timeoutMs: 1000, readApprovalPolicy: policy,
    clientFactory: () => clientWithApproval(responses, { command: "svn revert", cwd: session.project_path }),
  });
  await executor.run({ session, content: "revert", onApproval: async (request) => { captured = request; return "approve"; } });
  assert.equal(captured.operationClass, "svn-revert");
  assert.equal(captured.grantEligible, true);
  assert.deepEqual(responses, [{ id: 7, result: { decision: "accept" } }]);
});

test("always_allow audits a trusted PowerShell host before accepting without an approval callback", async () => {
  const responses = [];
  const calls = [];
  let approvals = 0;
  let classifications = 0;
  const policy = {
    classifyTrustedPowerShellHost: () => ({ trustedPowerShellHost: true, executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" }),
    classifyOperation: async () => { classifications += 1; return { autoApprove: false }; },
    isProtectedPath: () => false,
  };
  const executor = new CodexExecutor({
    executable: "codex.exe", timeoutMs: 1000, readApprovalPolicy: policy,
    powershellApprovalMode: "always_allow",
    auditPowerShell: async (record) => { calls.push(record); },
    clientFactory: () => clientWithApproval(responses, {
      command: "trusted arbitrary command", commandActions: [], networkApprovalContext: {}, additionalPermissions: ["all"],
    }),
  });
  await executor.run({
    session, taskId: "TASK-1", content: "run",
    onApproval: async () => { approvals += 1; return "approve"; },
  });
  assert.equal(approvals, 0);
  assert.equal(classifications, 0);
  assert.deepEqual(calls, [{
    taskId: "TASK-1",
    sessionId: session.id,
    executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    requestId: 7,
  }]);
  assert.deepEqual(responses, [{ id: 7, result: { decision: "accept" } }]);
});

test("audit failure declines directly without classification or approval fallback", async () => {
  const responses = [];
  let approvals = 0;
  let classifications = 0;
  const executor = new CodexExecutor({
    executable: "codex.exe", timeoutMs: 1000, powershellApprovalMode: "always_allow",
    readApprovalPolicy: {
      classifyTrustedPowerShellHost: () => ({ trustedPowerShellHost: true, executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" }),
      classifyOperation: async () => { classifications += 1; return { autoApprove: true }; },
      isProtectedPath: () => false,
    },
    auditPowerShell: async () => { throw new Error("disk full"); },
    clientFactory: () => clientWithApproval(responses, { command: "trusted" }),
  });
  await executor.run({
    session, taskId: "TASK-2", content: "run",
    onApproval: async () => { approvals += 1; return "approve"; },
  });
  assert.equal(approvals, 0);
  assert.equal(classifications, 0);
  assert.deepEqual(responses, [{ id: 7, result: { decision: "decline" } }]);
});

test("review mode preserves normal approval behavior for a trusted host", async () => {
  const responses = [];
  let approvals = 0;
  const executor = new CodexExecutor({
    executable: "codex.exe", timeoutMs: 1000, powershellApprovalMode: "review",
    readApprovalPolicy: {
      classifyTrustedPowerShellHost: () => ({ trustedPowerShellHost: true, executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" }),
      classifyOperation: async () => ({ autoApprove: false, operationClass: null, grantEligible: false }),
      isProtectedPath: () => false,
    },
    auditPowerShell: async () => { throw new Error("must not audit"); },
    clientFactory: () => clientWithApproval(responses, { command: "trusted" }),
  });
  await executor.run({
    session, taskId: "TASK-3", content: "run",
    onApproval: async () => { approvals += 1; return "reject"; },
  });
  assert.equal(approvals, 1);
  assert.deepEqual(responses, [{ id: 7, result: { decision: "decline" } }]);
});

test("PowerShell audit JSONL contains identifiers only and is durable before return", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "powershell-audit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const auditPath = path.join(root, "audit.jsonl");
  auditPowerShellApproval({
    taskId: "TASK-4", sessionId: "SESSION-4",
    executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    requestId: 42,
  }, { auditPath });
  const line = fs.readFileSync(auditPath, "utf8").trim();
  const record = JSON.parse(line);
  assert.deepEqual(Object.keys(record).sort(), ["event", "executable", "requestId", "sessionId", "taskId", "timestamp"]);
  assert.equal(record.event, "powershell_auto_approved");
  assert.equal(record.taskId, "TASK-4");
  assert.equal(record.sessionId, "SESSION-4");
  assert.equal(record.requestId, "42");
  assert.ok(!line.includes("command"));
  assert.ok(!line.includes("hash"));
  assert.ok(!line.includes("length"));
});
