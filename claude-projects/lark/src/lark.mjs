import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { loadChildEnvironment } from "./config.mjs";
import { logger } from "./logger.mjs";
import { runProcess } from "./process-utils.mjs";

function normalizeContent(value) {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object") {
    try { return JSON.stringify(value); } catch { return ""; }
  }
  return "";
}

const POST_RESOURCE_PATTERN = /!\[[^\]\r\n]*\]\(\s*img_[^)\r\n]+\)|<\s*\/?\s*(?:audio|file|folder|image|media|sticker|video)\b[^>]*>/i;

export function classifyInboundMessage(messageType, content) {
  if (messageType === "text") return "text";
  if (messageType === "audio") return "audio";
  if (messageType !== "post") return "unsupported";
  return POST_RESOURCE_PATTERN.test(String(content || "")) ? "post_resource" : "text";
}

export function canAcceptUserMessage(message, allowedOpenIds) {
  return message.chat_type === "p2p" && message.sender_type === "user"
    && allowedOpenIds.includes(message.sender_id) && Boolean(message.message_id)
    && (classifyInboundMessage(message.message_type, message.content) === "unsupported" || Boolean(message.content));
}

export function inboundUnavailableText(message, voiceEnabled) {
  const kind = classifyInboundMessage(message.message_type, message.content);
  if (kind === "unsupported") return "当前远程控制仅支持纯文本和语音，暂不支持直接发送图片、文件或视频。请改发文字说明。";
  if (kind === "post_resource") return "此条富文本消息包含图片或附件，无法作为远程指令处理；请改发纯文本消息。";
  if (kind === "audio" && !voiceEnabled) return "当前网关未启用语音消息，请改发文字。";
  return null;
}

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
    content: normalizeContent(value.content),
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

  async stop({ timeoutMs = 5000 } = {}) {
    this.stopping = true;
    this.ready = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    if (!child) return;
    const closed = new Promise((resolve) => child.once("close", resolve));
    if (child.stdin && !child.stdin.destroyed) child.stdin.end();
    let timer;
    try {
      await Promise.race([
        closed,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("飞书事件监听停止超时")), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
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
