const REQUEST_ID = /^RQ-\d{6}-[A-F0-9]{6}$/u;
const SVN_RESTORE_FORMS = new Set([
  "还原svn所有修改",
  "恢复svn所有修改",
  "svn还原所有修改",
  "svn恢复所有修改",
  "revertallsvnchanges",
]);

function normalized(value) {
  return String(value || "").normalize("NFKC").trim();
}

export function parseApprovalControl(value, messageType = "text") {
  const text = normalized(value);
  if (messageType !== "text") {
    return /^(?:批准|拒绝|全部批准)/u.test(text) ? Object.freeze({ type: "invalid-approval" }) : null;
  }
  const direct = text.match(/^(批准|拒绝)\s+(RQ-\d{6}-[A-F0-9]{6})$/iu);
  if (direct && REQUEST_ID.test(direct[2].toUpperCase())) {
    return Object.freeze({
      type: direct[1] === "批准" ? "approve" : "reject",
      requestRef: direct[2].toUpperCase(),
    });
  }
  if (text === "批准同类") return Object.freeze({ type: "approve-scope", mode: "class" });
  if (text === "全部批准") return Object.freeze({ type: "approve-scope", mode: "task" });
  return /^(?:批准|拒绝|全部批准)/u.test(text) ? Object.freeze({ type: "invalid-approval" }) : null;
}

export function approvalProfileForTypedTask(content, messageType = "text") {
  if (messageType !== "text") return null;
  const key = normalized(content).toLowerCase().replace(/\s+/gu, "");
  if (!SVN_RESTORE_FORMS.has(key)) return null;
  return Object.freeze({ version: 1, grants: Object.freeze(["svn-status", "svn-revert"]) });
}

export function serializeApprovalProfile(profile) {
  if (!profile) return null;
  if (profile.version !== 1 || !Array.isArray(profile.grants)) throw new Error("Approval profile is invalid");
  const grants = [...new Set(profile.grants)].sort();
  if (grants.some((item) => !["svn-status", "svn-revert"].includes(item))) throw new Error("Approval profile grant is invalid");
  return JSON.stringify({ version: 1, grants });
}

export function parseApprovalProfile(value) {
  if (!value) return Object.freeze([]);
  try {
    const parsed = JSON.parse(value);
    if (parsed?.version !== 1 || !Array.isArray(parsed.grants)
      || parsed.grants.some((item) => !["svn-status", "svn-revert"].includes(item))) return Object.freeze([]);
    return Object.freeze([...new Set(parsed.grants)]);
  } catch {
    return Object.freeze([]);
  }
}
