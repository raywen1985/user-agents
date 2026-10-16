import assert from "node:assert/strict";
import test from "node:test";
import { CodexExecutor } from "../src/executors/codex.mjs";

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
