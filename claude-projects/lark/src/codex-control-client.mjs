import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

class RpcConnection {
  constructor({ send, close, requestTimeoutMs, maxFrameBytes }) {
    this.sendRaw = send;
    this.closeRaw = close;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxFrameBytes = maxFrameBytes;
    this.nextId = 1;
    this.pending = new Map();
  }

  receive(text) {
    if (Buffer.byteLength(text, "utf8") > this.maxFrameBytes) return this.fail(new Error("Codex control frame exceeded the limit"));
    let message;
    try { message = JSON.parse(text); } catch { return this.fail(new Error("Codex control returned invalid JSON")); }
    if (message?.id == null) return;
    const pending = this.pending.get(String(message.id));
    if (!pending) return;
    this.pending.delete(String(message.id));
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(`Codex control request failed (${message.error.code ?? "unknown"})`));
    else pending.resolve(message.result);
  }

  request(method, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    if (Buffer.byteLength(payload, "utf8") > this.maxFrameBytes) return Promise.reject(new Error("Codex control request exceeded the limit"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        const error = new Error(`Codex control request timed out: ${method}`);
        error.code = "ETIMEDOUT";
        reject(error);
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(String(id), { resolve, reject, timer });
      try { this.sendRaw(payload); } catch (error) {
        clearTimeout(timer);
        this.pending.delete(String(id));
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    const payload = JSON.stringify({ method, params });
    if (Buffer.byteLength(payload, "utf8") > this.maxFrameBytes) throw new Error("Codex control notification exceeded the limit");
    this.sendRaw(payload);
  }

  fail(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    this.fail(new Error("Codex control connection closed"));
    this.closeRaw();
  }
}

function connectProxy(endpoint, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(options.executable, ["app-server", "proxy", "--sock", endpoint.socketPath], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderrBytes = 0;
    let settled = false;
    let connection;
    const finishError = (error) => {
      connection?.fail(error);
      if (!settled) { settled = true; reject(error); }
    };
    connection = new RpcConnection({
      requestTimeoutMs: options.requestTimeoutMs,
      maxFrameBytes: options.maxFrameBytes,
      send: (text) => child.stdin.write(`${text}\n`),
      close: () => { child.stdin.end(); child.kill(); },
    });
    child.stdout.on("data", (chunk) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length > options.maxFrameBytes * 2) return finishError(new Error("Codex proxy output exceeded the limit"));
      let newline;
      while ((newline = stdout.indexOf(10)) >= 0) {
        const frame = stdout.subarray(0, newline).toString("utf8").trim();
        stdout = stdout.subarray(newline + 1);
        if (frame) connection.receive(frame);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > options.maxFrameBytes) finishError(new Error("Codex proxy diagnostics exceeded the limit"));
    });
    child.once("error", finishError);
    child.once("exit", (code) => finishError(new Error(`Codex proxy exited (${code})`)));
    child.once("spawn", () => { settled = true; resolve(connection); });
  });
}

function encodeWebSocketFrame(text, opcode = 1) {
  const payload = Buffer.from(text, "utf8");
  const mask = randomBytes(4);
  const prefix = payload.length < 126 ? Buffer.from([0x80 | opcode, 0x80 | payload.length])
    : payload.length <= 65535
      ? Buffer.from([0x80 | opcode, 0x80 | 126, payload.length >> 8, payload.length & 0xff])
      : (() => {
        const header = Buffer.alloc(10);
        header[0] = 0x80 | opcode;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(payload.length), 2);
        return header;
      })();
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) masked[index] = payload[index] ^ mask[index % 4];
  return Buffer.concat([prefix, mask, masked]);
}

function connectWebSocket(endpoint, options) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint.url);
    const token = fs.readFileSync(endpoint.tokenFile, "utf8").trim();
    if (!token || Buffer.byteLength(token, "utf8") > 4096) return reject(new Error("Codex control token is invalid"));
    const socket = net.createConnection({ host: url.hostname.replace(/^\[(.*)\]$/, "$1"), port: Number(url.port) });
    const key = randomBytes(16).toString("base64");
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    let connection;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Codex control WebSocket connection timed out"));
    }, options.connectTimeoutMs);
    timer.unref?.();
    const fail = (error) => {
      connection?.fail(error);
      if (!upgraded) { clearTimeout(timer); reject(error); }
      socket.destroy();
    };
    connection = new RpcConnection({
      requestTimeoutMs: options.requestTimeoutMs,
      maxFrameBytes: options.maxFrameBytes,
      send: (text) => socket.write(encodeWebSocketFrame(text)),
      close: () => { try { socket.write(encodeWebSocketFrame("", 8)); } catch {} socket.destroy(); },
    });
    const consumeFrames = () => {
      while (buffer.length >= 2) {
        const first = buffer[0];
        const second = buffer[1];
        if ((first & 0x80) === 0 || (second & 0x80) !== 0) return fail(new Error("Unsupported Codex WebSocket frame"));
        let length = second & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2); offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          const large = buffer.readBigUInt64BE(2);
          if (large > BigInt(options.maxFrameBytes)) return fail(new Error("Codex WebSocket frame exceeded the limit"));
          length = Number(large); offset = 10;
        }
        if (length > options.maxFrameBytes) return fail(new Error("Codex WebSocket frame exceeded the limit"));
        if (buffer.length < offset + length) return;
        const payload = buffer.subarray(offset, offset + length);
        buffer = buffer.subarray(offset + length);
        const opcode = first & 0x0f;
        if (opcode === 1) connection.receive(payload.toString("utf8"));
        else if (opcode === 8) return fail(new Error("Codex WebSocket closed"));
        else if (opcode === 9) socket.write(encodeWebSocketFrame(payload.toString("utf8"), 10));
      }
    };
    socket.on("connect", () => {
      const pathname = `${url.pathname || "/"}`;
      socket.write([
        `GET ${pathname} HTTP/1.1`,
        `Host: ${url.host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        `Authorization: Bearer ${token}`,
        "\r\n",
      ].join("\r\n"));
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        if (buffer.length > 16384) return fail(new Error("Codex WebSocket handshake exceeded the limit"));
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const headers = buffer.subarray(0, end).toString("ascii");
        buffer = buffer.subarray(end + 4);
        const expected = createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
        if (!/^HTTP\/1\.1 101\b/m.test(headers) || !new RegExp(`^Sec-WebSocket-Accept:\\s*${expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "im").test(headers)) {
          return fail(new Error("Codex WebSocket authentication or upgrade failed"));
        }
        upgraded = true;
        clearTimeout(timer);
        resolve(connection);
      }
      consumeFrames();
    });
    socket.once("error", fail);
    socket.once("close", () => connection.fail(new Error("Codex WebSocket closed")));
  });
}

async function initialize(connection) {
  await connection.request("initialize", {
    clientInfo: { name: "lark-claude", title: "Lark Claude Gateway", version: "0.1.0" },
    capabilities: {},
  });
  connection.notify("initialized", {});
  return connection;
}

function loadedThreads(result) {
  return Array.isArray(result?.data) ? result.data : Array.isArray(result?.threads) ? result.threads : [];
}

function threadIdOf(thread) {
  return String(thread?.id || thread?.threadId || thread?.thread_id || "");
}

function exactTurn(result, turnId) {
  const thread = result?.thread || result;
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const latest = turns.at(-1);
  const exact = turns.find((turn) => String(turn?.id || turn?.turnId || turn?.turn_id || "") === turnId);
  if (!exact) return null;
  const exactId = String(exact.id || exact.turnId || exact.turn_id || "");
  const latestId = String(latest?.id || latest?.turnId || latest?.turn_id || "");
  return { id: exactId, status: String(exact.status || ""), latest: exactId === latestId };
}

async function endpointOwns(connection, threadId, turnId) {
  let cursor = null;
  let loaded = false;
  for (let page = 0; page < 4; page += 1) {
    const result = await connection.request("thread/loaded/list", { cursor, limit: 100 });
    if (loadedThreads(result).some((thread) => threadIdOf(thread) === threadId)) { loaded = true; break; }
    cursor = result?.nextCursor || result?.next_cursor || null;
    if (!cursor) break;
  }
  if (!loaded) return { owns: false, reason: "control_unreachable" };
  const result = await connection.request("thread/read", { threadId, includeTurns: true });
  const turn = exactTurn(result, turnId);
  if (!turn || !turn.latest) return { owns: false, reason: "stale_target" };
  return { owns: turn.status === "inProgress", reason: turn.status === "inProgress" ? null : "already_finished", turn };
}

export class CodexControlManager {
  constructor({ config, resolveExecutable, connectEndpoint = null, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
    this.config = config || { endpoints: [] };
    this.resolveExecutable = resolveExecutable;
    this.connectEndpoint = connectEndpoint || (async (endpoint) => {
      const options = { ...this.config, executable: await this.resolveExecutable() };
      return initialize(endpoint.transport === "proxy" ? await connectProxy(endpoint, options) : await connectWebSocket(endpoint, options));
    });
    this.sleep = sleep;
  }

  async probeExactOwner({ threadId, turnId }) {
    const owners = [];
    let lastReason = "control_unreachable";
    for (const endpoint of this.config.endpoints || []) {
      let connection;
      try {
        connection = await this.connectEndpoint(endpoint);
        const result = await endpointOwns(connection, threadId, turnId);
        if (result.owns) owners.push({ endpoint, connection });
        else { lastReason = result.reason || lastReason; connection.close(); }
      } catch {
        connection?.close?.();
        lastReason = "control_unreachable";
      }
    }
    if (owners.length !== 1) {
      for (const owner of owners) owner.connection.close();
      return { ready: false, reason: owners.length > 1 ? "ambiguous_control_owner" : lastReason };
    }
    return { ready: true, endpointId: owners[0].endpoint.id, connection: owners[0].connection };
  }

  async interruptExact({ endpointId, threadId, turnId, verifyTimeoutMs = 5000 }) {
    const owner = await this.probeExactOwner({ threadId, turnId });
    if (!owner.ready) return { ok: false, outcome: owner.reason };
    if (owner.endpointId !== endpointId) { owner.connection.close(); return { ok: false, outcome: "stale_target" }; }
    try {
      const accepted = await owner.connection.request("turn/interrupt", { threadId, turnId });
      if (!accepted || Object.keys(accepted).length !== 0) return { ok: false, outcome: "control_incompatible" };
      const deadline = Date.now() + verifyTimeoutMs;
      while (Date.now() <= deadline) {
        const read = await owner.connection.request("thread/read", { threadId, includeTurns: true });
        const turn = exactTurn(read, turnId);
        if (turn?.status === "interrupted") return { ok: true, outcome: "stopped" };
        if (!turn || turn.status !== "inProgress") return { ok: false, outcome: "completion_race" };
        await this.sleep(100);
      }
      return { ok: false, outcome: "stop_timeout" };
    } finally {
      owner.connection.close();
    }
  }
}
