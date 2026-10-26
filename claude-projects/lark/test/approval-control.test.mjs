import assert from "node:assert/strict";
import test from "node:test";
import {
  approvalProfileForTypedTask,
  parseApprovalControl,
  parseApprovalProfile,
  serializeApprovalProfile,
} from "../src/approval-control.mjs";

test("approval controls use a closed exact text grammar", () => {
  assert.deepEqual(parseApprovalControl("批准 RQ-261021-A1B2C3"), { type: "approve", requestRef: "RQ-261021-A1B2C3" });
  assert.deepEqual(parseApprovalControl("拒绝 rq-261021-a1b2c3"), { type: "reject", requestRef: "RQ-261021-A1B2C3" });
  assert.deepEqual(parseApprovalControl("批准同类"), { type: "approve-scope", mode: "class" });
  assert.deepEqual(parseApprovalControl("全部批准"), { type: "approve-scope", mode: "task" });
  for (const value of ["批准", "批准全部", "批准 RQ-261021-A1B2C3 谢谢", "不要批准 RQ-261021-A1B2C3"]) {
    assert.notEqual(parseApprovalControl(value)?.type, "approve");
  }
  assert.equal(parseApprovalControl("全部批准", "audio").type, "invalid-approval");
});

test("destructive profiles come only from exact typed SVN restore tasks", () => {
  const expected = { version: 1, grants: ["svn-status", "svn-revert"] };
  assert.deepEqual(approvalProfileForTypedTask("还原svn所有修改"), expected);
  assert.deepEqual(approvalProfileForTypedTask("revert all svn changes"), expected);
  assert.equal(approvalProfileForTypedTask("请还原svn所有修改"), null);
  assert.equal(approvalProfileForTypedTask("还原svn所有修改", "audio"), null);
  assert.deepEqual(parseApprovalProfile(serializeApprovalProfile(expected)), ["svn-revert", "svn-status"]);
});
