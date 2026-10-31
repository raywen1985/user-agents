import { randomUUID } from "node:crypto";
import { loadClaudeEnvironment, validateClaudeExecutionMode } from "../config.mjs";
import { runProcess } from "../process-utils.mjs";
import { sanitizeText } from "../sanitize.mjs";

const WORKER_PROMPT = [
  "你是飞书网关的任务执行器，消息路由已经完成。请使用当前可用工具执行用户任务。",
  "当前工作目录是任务的初始目录，不是文件访问沙箱；可按任务需要访问其他目录、运行终端命令和使用已配置的 MCP、技能。",
  "以本次实际提供的工具和权限为准，不要沿用旧对话中‘只有文件工具’的能力判断。",
  "若遇到真实的系统权限、缺少软件或服务未启动问题，请检查并准确报告原因。",
].join("\n");

function parseResult(stdout) {
  const payload = JSON.parse(stdout);
  if (payload.is_error) throw new Error(payload.result || "Claude 执行失败");
  return {
    nativeId: payload.session_id || null,
    summary: sanitizeText(payload.result || "Claude 已完成任务。"),
  };
}

export class ClaudeExecutor {
  constructor({ executable, model, timeoutMs, summaryLength = 500, executionMode = "restricted", beforeRun = null, beforeResume = null, runProcessImpl = runProcess }) {
    this.executable = executable;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.summaryLength = summaryLength;
    this.executionMode = validateClaudeExecutionMode(executionMode);
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
    const permissionArgs = this.executionMode === "full_access" ? [
      "--tools", "default",
      "--permission-mode", "bypassPermissions",
      "--setting-sources", "user,project,local",
      "--settings", JSON.stringify({ enableAllProjectMcpServers: true }),
      // Resumed sessions must rebuild the old restricted system prompt.
      "--system-prompt-snapshot", "off",
      "--append-system-prompt", WORKER_PROMPT,
    ] : [
      "--restricted",
      "--tools", "Read,Edit,Write,Glob,Grep",
      "--permission-mode", "acceptEdits",
      "--setting-sources", "local",
      "--strict-mcp-config",
      "--disable-slash-commands",
    ];
    const args = [
      "-p", content,
      "--output-format", "json",
      "--model", this.model,
      ...permissionArgs,
      "--name", session.name,
    ];
    if (session.native_id) args.push("--resume", nativeId);
    else args.push("--session-id", nativeId);

    const result = await this.runProcess(this.executable, args, {
      cwd: session.project_path,
      env: loadClaudeEnvironment({ executionMode: this.executionMode }),
      timeoutMs: this.timeoutMs,
      signal,
    });
    if (result.code !== 0) throw new Error(result.stderr || `Claude 退出码 ${result.code}`);
    const parsed = parseResult(result.stdout);
    return { nativeId: parsed.nativeId || nativeId, summary: sanitizeText(parsed.summary, this.summaryLength) };
  }
}
