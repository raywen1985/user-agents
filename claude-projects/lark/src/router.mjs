import fs from "node:fs";
import path from "node:path";
import { loadClaudeEnvironment, projectRoot } from "./config.mjs";
import { runProcess } from "./process-utils.mjs";

function parseClaudeJson(stdout) {
  const payload = JSON.parse(stdout);
  const value = payload.structured_output ?? payload.structuredOutput;
  if (!value || typeof value !== "object") throw new Error("Claude 未返回 structured_output");
  return value;
}

export class ClaudeRouter {
  constructor({ executable, model, timeoutMs }) {
    this.executable = executable;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.schema = JSON.parse(fs.readFileSync(path.join(projectRoot, "schemas", "intent.schema.json"), "utf8"));
    this.systemPrompt = fs.readFileSync(path.join(projectRoot, "prompts", "route.md"), "utf8");
  }

  async route(message, context) {
    const prompt = [
      "请根据以下网关上下文解析当前消息。",
      "上下文 JSON：",
      JSON.stringify(context),
      "当前飞书消息：",
      JSON.stringify({ content: message.content, reply_to: message.reply_to }),
    ].join("\n");
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await runProcess(this.executable, [
          "-p", prompt,
          "--output-format", "json",
          "--json-schema", JSON.stringify(this.schema),
          "--system-prompt", this.systemPrompt,
          "--model", this.model,
          "--restricted",
          "--tools", "",
          "--permission-mode", "plan",
          "--setting-sources", "local",
          "--strict-mcp-config",
          "--disable-slash-commands",
          "--no-session-persistence",
        ], { cwd: projectRoot, env: loadClaudeEnvironment(), timeoutMs: this.timeoutMs });
        if (result.code !== 0) throw new Error(result.stderr || `Claude 路由退出码 ${result.code}`);
        return parseClaudeJson(result.stdout);
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`自然语言路由失败: ${lastError?.message || "未知错误"}`);
  }
}
