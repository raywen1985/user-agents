import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("installer helpers preserve settings ownership and publish recovery metadata", { skip: process.platform !== "win32" }, () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const result = spawnSync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", path.join(root, "test", "install-support.test.ps1"),
    "-SupportPath", path.join(root, "scripts", "install-support.ps1"),
  ], { cwd: root, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim());
  assert.deepEqual(payload, { ok: true, permissions: 8, targets: 4 });
});
