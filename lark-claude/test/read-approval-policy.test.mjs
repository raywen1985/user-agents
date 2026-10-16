import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ReadApprovalPolicy, isSafeFileChange } from "../src/read-approval-policy.mjs";
import { shlexJoin13 } from "../src/shlex-1.3.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-read-policy-"));
  fs.writeFileSync(path.join(root, "README.md"), "ok\n");
  fs.mkdirSync(path.join(root, ".agents", "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agents", "docs", "instructions.md"), "rules\n");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const policy = ReadApprovalPolicy.create({ projectRoots: [root] });
  const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return { root, policy, powershell };
}

function request(root, powershell, script, action, switches = ["-NoProfile"]) {
  return {
    kind: "command",
    cwd: root,
    command: shlexJoin13([powershell, ...switches, "-Command", script]),
    commandActions: [action],
  };
}

test("safe project-local Get-Content is accepted", async (t) => {
  const { root, policy, powershell } = fixture(t);
  const script = "Get-Content -Raw .\\README.md";
  const params = request(root, powershell, script, {
    type: "read", command: script, name: "README.md", path: path.join(root, "README.md"),
  });
  assert.equal(await policy.classify(params, root), true);
  assert.equal(await policy.classify(request(root, powershell, script, params.commandActions[0], []), root), true);
});

test("captured conditional shape accepts one aggregate unknown action and absent leaf", async (t) => {
  const { root, policy, powershell } = fixture(t);
  const script = "if (Test-Path .\\missing.md) { Get-Content -Raw .\\missing.md }";
  const params = request(root, powershell, script, { type: "unknown", command: script });
  assert.equal(await policy.classify(params, root), true);
  assert.equal(await policy.classify({ ...params, commandActions: [{ type: "read", command: script, path: path.join(root, "missing.md") }] }, root), false);
});

test("unsafe and ambiguous commands fail closed", async (t) => {
  const { root, policy, powershell } = fixture(t);
  const write = "Set-Content .\\x.txt nope";
  assert.equal(await policy.classify(request(root, powershell, write, { type: "unknown", command: write }), root), false);
  const outside = "Get-Content -Raw C:\\Windows\\win.ini";
  assert.equal(await policy.classify(request(root, powershell, outside, { type: "read", command: outside, name: "win.ini", path: "C:\\Windows\\win.ini" }), root), false);
  assert.equal(await policy.classify({ cwd: root, command: "rg TODO .", commandActions: [{ type: "search", command: "rg TODO ." }] }, root), false);
  const safe = "Get-Content -Raw .\\README.md";
  const canonical = request(root, powershell, safe, { type: "read", command: safe, name: "README.md", path: path.join(root, "README.md") });
  assert.equal(await policy.classify({ ...canonical, command: canonical.command.replace(" -Command ", "  -Command ") }, root), false);
});

test("unsupported PowerShell grammar and operands fail closed", async (t) => {
  const { root, policy, powershell } = fixture(t);
  const scripts = [
    "Get-Content .\\README.md | Set-Content .\\x.txt",
    "Get-Content .\\README.md; Get-Content .\\README.md",
    "$p = '.\\README.md'; Get-Content $p",
    "gc .\\README.md",
    "Get-Content -Path .\\README.md",
    "Get-Content .\\*.md",
    "Get-Content ..\\outside.md",
    "#requires -RunAsAdministrator\nGet-Content .\\README.md",
  ];
  const decisions = await Promise.all(scripts.map((script) => policy.classify(
    request(root, powershell, script, { type: "unknown", command: script }), root,
  )));
  assert.deepEqual(decisions, scripts.map(() => false));
});

test("compatibility mode rejects the target host when a profile appears", async (t) => {
  const { root, policy, powershell } = fixture(t);
  const profile = path.join(root, "profile.ps1");
  fs.writeFileSync(profile, "throw 'profile must not run'\n");
  policy.hostProfiles.set(path.resolve(powershell).toLowerCase(), [profile.toLowerCase()]);
  const script = "Get-Content -Raw .\\README.md";
  const action = { type: "read", command: script, name: "README.md", path: path.join(root, "README.md") };
  assert.equal(await policy.classify(request(root, powershell, script, action, []), root), false);
  assert.equal(await policy.classify(request(root, powershell, script, action, ["-NoProfile"]), root), true);
});

test("file changes reject deletes, escapes, and protected policy files", (t) => {
  const { root, policy } = fixture(t);
  assert.equal(isSafeFileChange({ type: "fileChange", changes: [{ path: path.join(root, "new.txt"), kind: { type: "add" } }] }, root, policy), true);
  assert.equal(isSafeFileChange({ type: "fileChange", changes: [{ path: path.join(root, "README.md"), kind: { type: "delete" } }] }, root, policy), false);
  assert.equal(isSafeFileChange({ type: "fileChange", changes: [{ path: policy.analyzerPath, kind: { type: "update" } }] }, root, policy), false);
});

test("dynamic project roots containing protected policy files disable automatic reads", (t) => {
  const { policy } = fixture(t);
  assert.equal(policy.isProjectRootSafe(path.dirname(policy.analyzerPath)), false);
  assert.equal(policy.isProjectRootSafe(path.dirname(policy.analyzerHost)), false);
});
