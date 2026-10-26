import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { loadChildEnvironment } from "../config.mjs";
import { isSafeFileChange } from "../read-approval-policy.mjs";
import { compactOneLine, sanitizeText } from "../sanitize.mjs";
import { auditPowerShellApproval, logger } from "../logger.mjs";

function commandText(params) {
  if (typeof params.command === "string") return params.command;
  return JSON.stringify(params.command || params.commandActions || "");
}

export { isSafeFileChange } from "../read-approval-policy.mjs";

class CodexRpcClient {
  constructor(executable, cwd) {
    this.child = spawn(executable, [
      "app-server", "--stdio",
      "-c", "mcp_servers={}",
      "-c", "features.rmcp_client=false",
      "-c", "web_search=\"disabled\"",
    ], {
      cwd,
      env: loadChildEnvironment(),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.nextId = 1;
    this.pending = new Map();
    this.items = new Map();
    this.listeners = new Set();
    this.stderr = "";
    this.closed = false;
    this.stdout = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.stdout.on("line", (line) => this.#onLine(line));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-4000); });
    this.child.on("close", (code) => this.#onClose(code));
    this.child.on("error", (error) => this.#failAll(error));
  }

  #write(message) {
    if (this.closed) throw new Error("Codex App Server 已关闭");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.#write({ id, method, params });
    });
  }

  notify(method, params = {}) {
    this.#write({ method, params });
  }

  respond(id, result) {
    this.#write({ id, result });
  }

  onMessage(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  #onLine(line) {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "item/started" || message.method === "item/completed") {
      const item = message.params?.item;
      if (item?.id) this.items.set(item.id, item);
    }
    for (const listener of this.listeners) listener(message);
  }

  #onClose(code) {
    this.closed = true;
    this.#failAll(new Error(`Codex App Server 已退出 (${code}): ${this.stderr}`));
  }

  #failAll(error) {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    this.child.kill();
  }
}

function agentText(item) {
  if (!item || item.type !== "agentMessage") return null;
  if (typeof item.text === "string") return item.text;
  if (typeof item.content === "string") return item.content;
  if (Array.isArray(item.content)) return item.content.map((part) => part.text || "").join("");
  return null;
}

function isInitialSpawnEnoent(error) {
  return error?.code === "ENOENT" || /\bENOENT\b/.test(error?.message || "");
}

export async function createInitializedCodexClient({
  cwd,
  resolveExecutable,
  invalidateExecutable = () => {},
  clientFactory = (executable, clientCwd) => new CodexRpcClient(executable, clientCwd),
}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const resolved = await resolveExecutable();
    const selection = typeof resolved === "string"
      ? { executable: resolved, source: "explicit" }
      : resolved;
    const client = clientFactory(selection.executable, cwd);
    try {
      await client.request("initialize", {
        clientInfo: { name: "lark-claude-gateway", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      client.notify("initialized", {});
      return { client, selection };
    } catch (error) {
      client.close();
      const retryable = attempt === 0 && selection.source !== "explicit" && isInitialSpawnEnoent(error);
      if (!retryable) throw error;
      await invalidateExecutable(selection.executable);
    }
  }
  throw new Error("Codex App Server 初始化失败");
}

export class CodexExecutor {
  constructor({
    executable, resolveExecutable, invalidateExecutable, clientFactory, timeoutMs, summaryLength = 500,
    beforeRun = null, beforeResume = null, readApprovalPolicy = null,
    powershellApprovalMode = "review", auditPowerShell = auditPowerShellApproval,
  }) {
    if (!resolveExecutable && !executable) throw new Error("Codex executable resolver is required");
    this.resolveExecutable = resolveExecutable || (async () => ({ executable, source: "explicit" }));
    this.invalidateExecutable = invalidateExecutable || (() => {});
    this.clientFactory = clientFactory;
    this.timeoutMs = timeoutMs;
    this.summaryLength = summaryLength;
    this.beforeRun = beforeRun;
    this.beforeResume = beforeResume;
    this.readApprovalPolicy = readApprovalPolicy;
    this.powershellApprovalMode = powershellApprovalMode;
    this.auditPowerShell = auditPowerShell;
  }

  async run({ session, taskId, content, signal, onApproval, onNativeId }) {
    let client;
    let turnId = null;
    let latestAgentText = "";
    let timeout;
    try {
      if (this.beforeRun) {
        const guarded = await this.beforeRun(session);
        if (!guarded?.ok) {
          const error = new Error("无法安全验证项目目录。");
          error.code = guarded?.reason || "project_unverified";
          throw error;
        }
      }
      ({ client } = await createInitializedCodexClient({
        cwd: session.project_path,
        resolveExecutable: this.resolveExecutable,
        invalidateExecutable: this.invalidateExecutable,
        clientFactory: this.clientFactory,
      }));
      const threadParams = {
        cwd: session.project_path,
        approvalPolicy: "untrusted",
        approvalsReviewer: "user",
        sandbox: "read-only",
        runtimeWorkspaceRoots: [session.project_path],
        developerInstructions: "你由飞书远程网关驱动。仅在当前项目内工作；结束时给出最小中文摘要，不要输出完整 transcript。不要调用协作子代理。",
      };
      if (session.native_id && this.beforeResume) {
        const guarded = await this.beforeResume(session);
        if (!guarded?.ok) {
          const error = new Error(guarded?.reason === "busy" ? "原生 Codex Session 正在使用中。" : "无法安全验证原生 Codex Session。");
          error.code = guarded?.reason || "snapshot_incomplete";
          throw error;
        }
      }
      const threadResult = session.native_id
        ? await client.request("thread/resume", { ...threadParams, threadId: session.native_id, excludeTurns: true })
        : await client.request("thread/start", threadParams);
      const threadId = threadResult.thread.id;
      onNativeId?.(threadId);
      await client.request("thread/name/set", { threadId, name: session.name });

      const completion = new Promise((resolve, reject) => {
        const remove = client.onMessage(async (message) => {
          try {
            if (message.method === "item/completed") {
              const text = agentText(message.params?.item);
              if (text) latestAgentText = text;
              return;
            }
            if (message.method === "item/commandExecution/requestApproval") {
              const params = message.params || {};
              const trustedHost = this.powershellApprovalMode === "always_allow"
                ? this.readApprovalPolicy?.classifyTrustedPowerShellHost?.(params)
                : null;
              if (trustedHost?.trustedPowerShellHost) {
                try {
                  await this.auditPowerShell({
                    taskId,
                    sessionId: session.id,
                    executable: trustedHost.executable,
                    requestId: message.id,
                  });
                  client.respond(message.id, { decision: "accept" });
                } catch (error) {
                  logger.error("PowerShell 自动批准审计失败", {
                    taskId,
                    sessionId: session.id,
                    error: error?.message || "audit_failed",
                  });
                  client.respond(message.id, { decision: "decline" });
                }
                return;
              }
              let classification = { autoApprove: false, operationClass: null, grantEligible: false };
              try {
                if (this.readApprovalPolicy?.classifyOperation) {
                  classification = await this.readApprovalPolicy.classifyOperation(params, session.project_path) || classification;
                } else if (await this.readApprovalPolicy?.classify?.(params, session.project_path)) {
                  classification = { autoApprove: true, operationClass: null, grantEligible: false };
                }
              } catch {}
              const decision = classification.autoApprove ? "accept" : await onApproval({
                kind: "command",
                description: `命令：${compactOneLine(commandText(params), 240)}`,
                operationClass: classification.operationClass,
                grantEligible: classification.grantEligible,
              });
              client.respond(message.id, { decision: decision === "approve" ? "accept" : decision === "reject" ? "decline" : decision });
              return;
            }
            if (message.method === "item/fileChange/requestApproval") {
              const item = client.items.get(message.params?.itemId);
              const safe = isSafeFileChange(item, session.project_path, this.readApprovalPolicy);
              const description = item?.changes?.map((change) => `${change.kind?.type || change.kind}: ${change.path}`).join("; ") || message.params?.reason || "文件修改";
              const decision = safe ? "accept" : await onApproval({ kind: "file", description: compactOneLine(description, 300) });
              client.respond(message.id, { decision: decision === "approve" ? "accept" : decision === "reject" ? "decline" : decision });
              return;
            }
            if (message.method === "turn/completed" && message.params?.turn?.id === turnId) {
              remove();
              resolve(message.params.turn);
            }
          } catch (error) {
            remove();
            reject(error);
          }
        });
      });

      const turnResult = await client.request("turn/start", {
        threadId,
        input: [{ type: "text", text: content }],
        cwd: session.project_path,
        approvalPolicy: "untrusted",
        approvalsReviewer: "user",
        runtimeWorkspaceRoots: [session.project_path],
      });
      turnId = turnResult.turn.id;

      const onAbort = () => {
        if (turnId) client.request("turn/interrupt", { threadId, turnId }).catch(() => {});
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      timeout = setTimeout(onAbort, this.timeoutMs);
      timeout.unref?.();
      const turn = await completion;
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) throw Object.assign(new Error("任务已取消"), { name: "AbortError" });
      if (["failed", "interrupted", "cancelled"].includes(turn.status)) {
        throw new Error(turn.error?.message || `Codex Turn 状态：${turn.status}`);
      }
      return {
        nativeId: threadId,
        summary: sanitizeText(latestAgentText || "Codex 已完成任务。", this.summaryLength),
      };
    } finally {
      if (timeout) clearTimeout(timeout);
      client?.close();
    }
  }
}
