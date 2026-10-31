const secretPatterns = [
  [/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]"],
  [/\bsk-[A-Za-z0-9_-]{8,}\b/gi, "[REDACTED]"],
  [/((?:api[_-]?key|access[_-]?token|token|secret|password)\s*[:=]\s*)\S+/gi, "$1[REDACTED]"],
];

export function sanitizeText(value, maxLength = 500) {
  let text = String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\r\n/g, "\n")
    .trim();
  for (const [pattern, replacement] of secretPatterns) text = text.replace(pattern, replacement);
  if (!text) return "没有可用摘要。";
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 3))}...` : text;
}

export function compactOneLine(value, maxLength = 160) {
  return sanitizeText(value, maxLength).replace(/\s+/g, " ").trim();
}
