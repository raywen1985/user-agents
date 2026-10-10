import { compactOneLine, sanitizeText } from "./sanitize.mjs";

export function sessionHeader(session) {
  const executor = session.executor === "codex" ? "Codex" : "Claude";
  return `[${executor} | ${session.project_alias} | ${session.name} | ${session.id}]`;
}

export function formatSessionMessage(session, body) {
  return `${sessionHeader(session)}\n${sanitizeText(body)}`;
}

export function formatSessionLine(session) {
  const summary = session.last_summary ? ` - ${compactOneLine(session.last_summary, 80)}` : "";
  return `${sessionHeader(session)} ${session.status}${summary}`;
}

export function formatError(error) {
  return compactOneLine(error?.message || error || "未知错误", 300);
}
