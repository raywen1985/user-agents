const EXECUTOR_PREFIX = /^\s*(codex|claude)(?=\s|$)/iu;
const POSITIVE_INTEGER = /^[1-9]\d*$/u;
const RESERVED_NEW = new Set(["new", "新建"]);

function takeToken(value) {
  const match = String(value || "").match(/^(\S+)(?:\s+([\s\S]*))?$/u);
  return match ? { token: match[1], rest: match[2]?.trim() || "" } : null;
}

function invalid(executor, reason) {
  return Object.freeze({ type: "invalid-command", executor, reason });
}

export function parseSessionCommand(value) {
  const text = String(value || "").trim();
  if (!text) return Object.freeze({ type: "not-command" });
  if (POSITIVE_INTEGER.test(text)) {
    return Object.freeze({ type: "number-selection", index: Number(text) - 1 });
  }
  if (text === "下一页") return Object.freeze({ type: "page-navigation", direction: "next" });
  if (text === "上一页") return Object.freeze({ type: "page-navigation", direction: "previous" });

  const prefix = text.match(EXECUTOR_PREFIX);
  if (!prefix) return Object.freeze({ type: "not-command" });
  const executor = prefix[1].toLowerCase();
  const remainder = text.slice(prefix[0].length).trim();
  if (!remainder) return invalid(executor, "missing_session_and_content");

  const first = takeToken(remainder);
  const explicitNew = RESERVED_NEW.has(first.token.toLowerCase());
  if (!explicitNew) {
    if (!first.rest) return invalid(executor, "missing_content");
    return Object.freeze({
      type: "continue-or-create",
      executor,
      sessionName: first.token,
      content: first.rest,
    });
  }

  if (!first.rest) return invalid(executor, "missing_session_and_content");
  const second = takeToken(first.rest);
  if (!second?.rest) return invalid(executor, "missing_content");
  return Object.freeze({
    type: "create-new",
    executor,
    sessionName: second.token,
    content: second.rest,
  });
}
