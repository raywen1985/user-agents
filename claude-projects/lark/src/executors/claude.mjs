import { randomUUID } from "node:crypto";
import { loadClaudeEnvironment } from "../config.mjs";
import { runProcess } from "../process-utils.mjs";
import { sanitizeText } from "../sanitize.mjs";

function parseResult(stdout) {
  const payload = JSON.parse(stdout);
  if (payload.is_error) throw new Error(payload.result || "Claude 执行失败");
  return {
    nativeId: payload.session_id || null,
    summary: sanitizeText(payload.result || "Claude 已完成任务。"),
  };
}

export class ClaudeExecutor {
  constructor({ executable, model, timeoutMs, summaryLength = 500, beforeRun = null, beforeResume = null, runProcessImpl = runProcess }) {
    this.executable = executable;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.summaryLength = summaryLength;
    this.beforeRun = beforeRun;
    this.beforeResume = beforeResume;
    this.runProcess = runProcessImpl;
  }

  async run({ session, content, signal, onNativeId }) {
    if (this.beforeRun) {
      const guarded = await this.beforeRun(session);
      if (!guarded?.ok) {
        const error = new Error("无法安全验证项目目录。");
        error.code = guarded?.reason || "project_unverified";
        throw error;
      }
    }
    const nativeId = session.native_id || randomUUID();
    onNativeId?.(nativeId);
    if (session.native_id && this.beforeResume) {
      const guarded = await this.beforeResume(session);
      if (!guarded?.ok) {
        const error = new Error(guarded?.reason === "busy" ? "原生 Claude Session 正在使用中。" : "无法安全验证原生 Claude Session。");
        error.code = guarded?.reason || "snapshot_incomplete";
        throw error;
      }
    }
    const args = [
      "-p", content,
      "--output-format", "json",
      "--model", this.model,
      "--restricted",
      "--tools", "Read,Edit,Write,Glob,Grep",
      "--permission-mode", "acceptEdits",
      "--setting-sources", "local",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--name", session.name,
    ];
    if (session.native_id) args.push("--resume", nativeId);
    else args.push("--session-id", nativeId);

    const result = await this.runProcess(this.executable, args, {
      cwd: session.project_path,
      env: loadClaudeEnvironment(),
      timeoutMs: this.timeoutMs,
      signal,
    });
    if (result.code !== 0) throw new Error(result.stderr || `Claude 退出码 ${result.code}`);
    const parsed = parseResult(result.stdout);
    return { nativeId: parsed.nativeId || nativeId, summary: sanitizeText(parsed.summary, this.summaryLength) };
  }
}
