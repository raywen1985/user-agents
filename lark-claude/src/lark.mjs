import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { loadChildEnvironment } from "./config.mjs";
import { logger } from "./logger.mjs";
import { runProcess } from "./process-utils.mjs";

export function normalizeLarkEvent(value) {
  if (!value || typeof value !== "object") return null;
  return {
    message_id: String(value.message_id || ""),
    sender_id: String(value.sender_id || ""),
    sender_type: String(value.sender_type || ""),
    chat_id: String(value.chat_id || ""),
    chat_type: String(value.chat_type || ""),
    message_type: String(value.message_type || ""),
    reply_to: value.reply_to ? String(value.reply_to) : null,
    content: String(value.content || "").trim(),
  };
}

export class LarkListener extends EventEmitter {
  constructor({ executable, restartDelayMs = 3000 }) {
    super();
    this.executable = executable;
    this.restartDelayMs = restartDelayMs;
    this.child = null;
    this.stopping = false;
    this.ready = false;
    this.restartTimer = null;
  }

  async start() {
    this.stopping = false;
    await this.#spawnAndWaitForReady();
  }

  async #spawnAndWaitForReady() {
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, ["event", "consume", "im.message.receive_v1", "--as", "bot"], {
        cwd: process.cwd(),
        env: loadChildEnvironment(),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;
      this.ready = false;
      let settled = false;
      let stderrTail = "";

      const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
      const stderr = createInterface({ input: child.stderr, crlfDelay: Infinity });
      stdout.on("line", (line) => {
        if (!line.trim()) return;
        try {
          const event = normalizeLarkEvent(JSON.parse(line));
          if (event) this.emit("event", event);
        } catch (error) {
          logger.warn("飞书事件 JSON 无法解析", { error: error.message, line: line.slice(0, 300) });
        }
      });
      stderr.on("line", (line) => {
        stderrTail = `${stderrTail}\n${line}`.slice(-2000);
        if (line.includes("[event] ready event_key=im.message.receive_v1")) {
          this.ready = true;
          if (!settled) {
            settled = true;
            logger.info("飞书事件监听已就绪");
            resolve();
          }
        } else if (line.trim()) {
          logger.debug("飞书事件监听输出", line);
        }
      });
      child.on("error", (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
      child.on("close", (code) => {
        this.ready = false;
        this.child = null;
        if (!settled) {
          settled = true;
          reject(new Error(`飞书事件监听启动失败 (${code}): ${stderrTail.trim()}`));
          return;
        }
        if (!this.stopping) {
          logger.warn("飞书事件监听已退出，准备重连", { code });
          this.#scheduleRestart();
        }
      });
    });
  }

  #scheduleRestart() {
    if (this.stopping || this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.#spawnAndWaitForReady().catch((error) => {
        logger.error("飞书事件监听重连失败", error.message);
        this.#scheduleRestart();
      });
    }, this.restartDelayMs);
    this.restartTimer.unref?.();
  }

  stop() {
    this.stopping = true;
    this.ready = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.child?.stdin && !this.child.stdin.destroyed) this.child.stdin.end();
  }
}

export class LarkMessenger {
  constructor({ executable, recipientOpenId }) {
    this.executable = executable;
    this.recipientOpenId = recipientOpenId;
  }

  async sendText(text, idempotencyKey) {
    const result = await runProcess(this.executable, [
      "im", "+messages-send",
      "--user-id", this.recipientOpenId,
      "--text", text,
      "--idempotency-key", String(idempotencyKey).slice(0, 50),
      "--as", "bot",
    ], { env: loadChildEnvironment(), timeoutMs: 60000 });
    if (result.code !== 0) throw new Error(`飞书发送失败: ${result.stderr || result.stdout}`);
    const payload = JSON.parse(result.stdout);
    if (payload.ok === false) throw new Error(payload.error?.message || "飞书发送失败");
    const data = payload.data || payload;
    return data.message_id || data.messageId || null;
  }
}
