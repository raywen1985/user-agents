import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectRoot } from "./config.mjs";

let logDirectory = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "lark-claude");
try {
  fs.mkdirSync(logDirectory, { recursive: true });
} catch {
  logDirectory = path.join(projectRoot, "logs");
  fs.mkdirSync(logDirectory, { recursive: true });
}
const logPath = path.join(logDirectory, "gateway.log");

function redact(value) {
  return String(value ?? "")
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gi, "[REDACTED]")
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)\S+/gi, "$1[REDACTED]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function write(level, message, details) {
  const suffix = details === undefined ? "" : ` ${redact(typeof details === "string" ? details : JSON.stringify(details))}`;
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${redact(message)}${suffix}`;
  console.log(line);
  fs.appendFileSync(logPath, `${line}\n`, "utf8");
}

export const logger = {
  info: (message, details) => write("info", message, details),
  warn: (message, details) => write("warn", message, details),
  error: (message, details) => write("error", message, details),
  debug: (message, details) => {
    if (process.env.LARK_GATEWAY_DEBUG === "1") write("debug", message, details);
  },
  path: logPath,
};
