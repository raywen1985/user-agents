import assert from "node:assert/strict";
import test from "node:test";
import { validatePowerShellApprovalMode } from "../src/config.mjs";

test("PowerShell approval mode defaults to review", () => {
  assert.equal(validatePowerShellApprovalMode(), "review");
  assert.equal(validatePowerShellApprovalMode(null), "review");
});

test("PowerShell approval mode accepts only the supported values", () => {
  assert.equal(validatePowerShellApprovalMode("review"), "review");
  assert.equal(validatePowerShellApprovalMode("always_allow"), "always_allow");
  assert.throws(() => validatePowerShellApprovalMode("allow"), /Unsupported PowerShell approval mode/);
});
