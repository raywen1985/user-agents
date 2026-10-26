import path from "node:path";
import { projectRoot } from "./config.mjs";
import { runProcess } from "./process-utils.mjs";

const STATES = new Set(["terminated", "alreadyExited", "reused", "accessDenied", "timeout", "error"]);

export async function terminateClaudeProcess({
  pid,
  procStart,
  waitMs = 5000,
  timeoutMs = 7000,
  env = process.env,
  run = runProcess,
}) {
  const numericPid = Number(pid);
  if (!Number.isSafeInteger(numericPid) || numericPid <= 0 || !/^\d{10,20}$/.test(String(procStart || ""))) {
    throw new Error("Claude process identity is invalid");
  }
  const boundedWait = Math.max(1, Math.min(5000, Number(waitMs) || 5000));
  const systemRoot = env.SystemRoot || env.SYSTEMROOT;
  if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error("SystemRoot is unavailable");
  const executable = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = path.join(projectRoot, "scripts", "session-probe.ps1");
  const result = await run(executable, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
  ], {
    cwd: projectRoot,
    input: JSON.stringify({ locks: [], processes: [], terminate: { pid: numericPid, procStart: String(procStart), waitMs: boundedWait } }),
    timeoutMs,
    maxOutputBytes: 262144,
  });
  if (result.code !== 0 || result.stderr.trim()) throw new Error(`Windows terminate helper failed (${result.code})`);
  const payload = JSON.parse(result.stdout);
  const outcome = payload?.terminate;
  if (!outcome || !STATES.has(outcome.state)) throw new Error("Windows terminate helper returned an invalid result");
  return Object.freeze({
    state: outcome.state,
    code: Number.isInteger(outcome.code) ? outcome.code : null,
    procStart: typeof outcome.procStart === "string" ? outcome.procStart : null,
  });
}
