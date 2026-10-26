import assert from "node:assert/strict";
import test from "node:test";
import {
  displaySessionName,
  matchSessionName,
  normalizeExactSessionName,
  normalizeSessionName,
  scoreNormalizedNames,
} from "../src/session-name-match.mjs";

function candidate(name, extra = {}) {
  return { identity: name, name, executor: "codex", projectAlias: "unity", updatedAt: 1, ...extra };
}

test("normalizes NFKC, case, whitespace and punctuation", () => {
  assert.equal(normalizeSessionName(" Ｒesource - LEAK ").compact, "resourceleak");
  assert.equal(normalizeSessionName("资源 泄漏").compact, "资源泄漏");
  assert.equal(normalizeSessionName("a"), null);
  assert.equal(normalizeSessionName("bad\u202ename"), null);
});

test("normalizes identity exact names without removing punctuation or width", () => {
  assert.equal(normalizeExactSessionName(" 飞书通知-2 ").key, "飞书通知-2");
  assert.equal(normalizeExactSessionName("IMPORT-Task").key, "import-task");
  assert.notEqual(normalizeExactSessionName("飞书通知-2").key, normalizeExactSessionName("飞书通知2").key);
  assert.notEqual(normalizeExactSessionName("Ａ").key, normalizeExactSessionName("A").key);
});

test("scores exact, reordered, contained and typo names deterministically", () => {
  const score = (left, right) => scoreNormalizedNames(normalizeSessionName(left), normalizeSessionName(right));
  assert.deepEqual(score("资源泄漏", "资源泄漏"), { score: 1, kind: "exact" });
  assert.deepEqual(score("leak resource", "resource leak"), { score: 0.98, kind: "reordered" });
  assert.equal(score("资源泄漏", "资源泄漏排查").kind, "contains");
  assert.equal(score("resource leak", "resource laek").kind, "edit");
});

test("selects only one clear candidate and preserves ambiguity", () => {
  const exact = matchSessionName("资源泄漏", [candidate("资源泄漏"), candidate("资源泄漏排查")]);
  assert.equal(exact.kind, "selected");
  assert.equal(exact.selected.name, "资源泄漏");

  const duplicate = matchSessionName("资源泄漏", [candidate("资源泄漏", { identity: "one" }), candidate("资源泄漏", { identity: "two" })]);
  assert.equal(duplicate.kind, "selection");

  const weak = matchSessionName("资源", [candidate("资源泄漏排查")]);
  assert.equal(weak.kind, "selection");
  assert.equal(matchSessionName("completely different", [candidate("资源泄漏")]).kind, "none");
});

test("never auto-selects punctuation-folded or high-confidence fuzzy matches", () => {
  const punctuation = matchSessionName("飞书通知-2", [candidate("飞书通知2")]);
  assert.equal(punctuation.kind, "selection");
  assert.equal(punctuation.matches[0].candidate.name, "飞书通知2");

  const fuzzy = matchSessionName("资源泄漏", [candidate("资源泄漏排查")]);
  assert.equal(fuzzy.kind, "selection");
});

test("matches a native UUID exactly and limits duplicate exact results to selection", () => {
  const nativeId = "11111111-1111-4111-8111-111111111111";
  const first = candidate("one", { identity: "one", nativeId });
  assert.equal(matchSessionName(nativeId, [first]).selected, first);
  const duplicate = candidate("two", { identity: "two", nativeId });
  assert.equal(matchSessionName(nativeId, [first, duplicate]).kind, "selection");
});

test("scores merged aliases once per canonical candidate", () => {
  const first = candidate("Gateway Name", { identity: "one", aliases: ["资源泄漏"] });
  const second = candidate("Other", { identity: "two", aliases: ["资源泄漏"] });
  assert.equal(matchSessionName("资源泄漏", [first]).selected, first);
  assert.equal(matchSessionName("资源泄漏", [first, second]).kind, "selection");
});

test("sanitizes display names and redacts UUID-shaped text", () => {
  assert.equal(displaySessionName("line\nname"), "line name");
  assert.equal(displaySessionName("task 11111111-1111-4111-8111-111111111111"), "task [id]");
});
