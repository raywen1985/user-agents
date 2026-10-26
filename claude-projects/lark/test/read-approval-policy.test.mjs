import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { ReadApprovalPolicy, isSafeFileChange } from "../src/read-approval-policy.mjs";
import { shlexJoin13 } from "../src/shlex-1.3.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-read-policy-"));
  fs.writeFileSync(path.join(root, "README.md"), "ok\n");
  fs.mkdirSync(path.join(root, ".agents", "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agents", "docs", "instructions.md"), "rules\n");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const svnPath = path.join(process.env.ProgramFiles, "TortoiseSVN", "bin", "svn.exe");
  const policy = ReadApprovalPolicy.create({ projectRoots: [root], svnPath });
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

test("trusted PowerShell host classification ignores command semantics and permission metadata", (t) => {
  const { root, policy, powershell } = fixture(t);
  const commandVariants = [
    ["-Command", "Remove-Item -Recurse -Force C:\\outside"],
    ["-File", "C:\\outside\\danger.ps1"],
    ["-EncodedCommand", "UwBlAHQALQBJAHQAZQBtAA=="],
  ];
  for (const args of commandVariants) {
    const params = {
      kind: "command",
      cwd: root,
      command: shlexJoin13([powershell, ...args]),
      networkApprovalContext: { host: "example.com" },
      additionalPermissions: ["network", "filesystem"],
    };
    for (const commandActions of [undefined, [], [{ type: "unknown" }], [{ type: "read" }, { type: "write" }]]) {
      assert.deepEqual(policy.classifyTrustedPowerShellHost({ ...params, commandActions }), {
        trustedPowerShellHost: true,
        executable: fs.realpathSync.native(powershell),
      });
    }
  }
});

test("trusted PowerShell host classification rejects aliases, copies, mentions, and malformed commands", (t) => {
  const { root, policy, powershell } = fixture(t);
  const copied = path.join(root, "powershell.exe");
  fs.copyFileSync(powershell, copied);
  const invalid = [
    "powershell.exe -Command Get-Date",
    shlexJoin13([copied, "-Command", "Get-Date"]),
    shlexJoin13(["cmd.exe", "/c", `echo ${powershell}`]),
    `\"${powershell}\"  -Command Get-Date`,
  ];
  for (const command of invalid) assert.equal(policy.classifyTrustedPowerShellHost({ command }), null);
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

test("trusted SVN status is automatic and recursive revert is task-grant eligible", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-svn-policy-"));
  const svn = "C:\\Program Files\\TortoiseSVN\\bin\\svn.exe";
  fs.writeFileSync(path.join(root, "tracked.txt"), "one\n");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const policy = ReadApprovalPolicy.create({ projectRoots: [root], svnPath: svn });
  const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const statusScript = "svn status";
  assert.deepEqual(await policy.classifyOperation(request(root, powershell, statusScript, {
    type: "unknown", command: statusScript,
  }), root), { autoApprove: true, operationClass: "svn-status", grantEligible: true });

  policy.spawnImpl = (command, args, options) => {
    if (!args.includes(policy.svnValidatorPath)) return spawn(command, args, options);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({
      write(_chunk, _encoding, callback) { callback(); },
      final(callback) {
        callback();
        setImmediate(() => {
          child.stdout.end('{"version":1,"safe":true,"reason":"safe_svn_revert"}\n');
          child.stderr.end();
          child.emit("close", 0);
        });
      },
    });
    child.kill = () => {};
    return child;
  };
  const revertScript = 'svn revert --depth infinity "."';
  assert.deepEqual(await policy.classifyOperation(request(root, powershell, revertScript, {
    type: "unknown", command: revertScript,
  }), root), { autoApprove: false, operationClass: "svn-revert", grantEligible: true });

  const combined = "svn status; svn revert --depth infinity .";
  assert.deepEqual(await policy.classifyOperation(request(root, powershell, combined, {
    type: "unknown", command: combined,
  }), root), { autoApprove: false, operationClass: null, grantEligible: false });
});
