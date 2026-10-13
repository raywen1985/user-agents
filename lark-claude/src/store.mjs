import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { projectRoot } from "./config.mjs";

function now() {
  return Date.now();
}

function shortId(prefix) {
  const date = new Date().toISOString().slice(2, 10).replaceAll("-", "");
  return `${prefix}-${date}-${randomBytes(3).toString("hex").toUpperCase()}`;
}

export class Store {
  constructor(databasePath = path.join(projectRoot, "data", "gateway.sqlite")) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS inbox (
        message_id TEXT PRIMARY KEY,
        sender_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        reply_to TEXT,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'received',
        received_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        executor TEXT NOT NULL CHECK (executor IN ('codex', 'claude')),
        project_alias TEXT NOT NULL,
        project_path TEXT NOT NULL,
        native_id TEXT,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        last_summary TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_recent_idx ON sessions(updated_at DESC);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        message_id TEXT UNIQUE,
        action TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS message_bindings (
        message_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        direction TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        task_id TEXT NOT NULL REFERENCES tasks(id),
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dedupe_key TEXT NOT NULL UNIQUE,
        text TEXT NOT NULL,
        session_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        remote_message_id TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        sent_at INTEGER
      );
    `);
  }

  acceptInbox(event) {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO inbox(message_id, sender_id, chat_id, reply_to, content, received_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(event.message_id, event.sender_id, event.chat_id, event.reply_to || null, event.content, now());
    return Number(result.changes) === 1;
  }

  markInbox(messageId, status) {
    this.db.prepare("UPDATE inbox SET status=? WHERE message_id=?").run(status, messageId);
  }

  createSession({ executor, projectAlias, projectPath, nativeId = null, name }) {
    const id = shortId(executor === "codex" ? "CX" : "CL");
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO sessions(id, executor, project_alias, project_path, native_id, name, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)
    `).run(id, executor, projectAlias, projectPath, nativeId, name, timestamp, timestamp);
    return this.getSession(id);
  }

  getSession(id) {
    return this.db.prepare("SELECT * FROM sessions WHERE id=?").get(id) || null;
  }

  listSessions(limit = 20) {
    return this.db.prepare("SELECT * FROM sessions WHERE status <> 'archived' ORDER BY updated_at DESC LIMIT ?").all(limit);
  }

  findSessions({ executor = null, projectAlias = null, reference = null } = {}) {
    let rows = this.listSessions(100);
    if (executor) rows = rows.filter((row) => row.executor === executor);
    if (projectAlias) rows = rows.filter((row) => row.project_alias.toLowerCase() === projectAlias.toLowerCase());
    if (reference) {
      const needle = String(reference).trim().toLowerCase();
      rows = rows.filter((row) => row.id.toLowerCase() === needle || row.name.toLowerCase() === needle);
    }
    return rows;
  }

  updateSession(id, fields) {
    const allowed = ["native_id", "name", "status", "last_summary"];
    const entries = Object.entries(fields).filter(([key]) => allowed.includes(key));
    if (entries.length === 0) return this.getSession(id);
    const sql = `UPDATE sessions SET ${entries.map(([key]) => `${key}=?`).join(", ")}, updated_at=? WHERE id=?`;
    this.db.prepare(sql).run(...entries.map(([, value]) => value), now(), id);
    return this.getSession(id);
  }

  createTask({ sessionId, messageId, action, content }) {
    const id = shortId("TK");
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO tasks(id, session_id, message_id, action, content, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)
    `).run(id, sessionId, messageId || null, action, content, timestamp, timestamp);
    return this.getTask(id);
  }

  getTask(id) {
    return this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) || null;
  }

  enrichActivitySnapshot(snapshot) {
    if (!Array.isArray(snapshot) || snapshot.length > 201) throw new Error("Scheduler activity snapshot is invalid");
    return snapshot.flatMap((entry) => {
      const session = this.getSession(entry.sessionId);
      const task = this.getTask(entry.taskId);
      if (!session || !task || task.session_id !== session.id) return [];
      return [{
        provider: "gateway",
        agent: session.executor,
        sessionId: session.id,
        gatewayId: session.id,
        nativeId: session.native_id,
        name: session.name,
        status: entry.phase,
        cwd: session.project_path,
        projectAlias: session.project_alias,
        pid: null,
        updatedAt: task.updated_at,
        taskId: task.id,
      }];
    });
  }

  latestTaskForSession(sessionId) {
    return this.db.prepare("SELECT * FROM tasks WHERE session_id=? ORDER BY updated_at DESC LIMIT 1").get(sessionId) || null;
  }

  listTasksByStatus(status) {
    return this.db.prepare("SELECT * FROM tasks WHERE status=? ORDER BY updated_at DESC").all(status);
  }

  recoverInterrupted() {
    const timestamp = now();
    this.db.prepare("UPDATE tasks SET status='interrupted', result='网关进程中断，任务未自动重试', updated_at=? WHERE status IN ('running', 'waiting_approval')").run(timestamp);
    this.db.prepare("UPDATE sessions SET status='interrupted', last_summary='网关进程中断，任务未自动重试', updated_at=? WHERE status IN ('running', 'waiting_approval')").run(timestamp);
    this.db.prepare("UPDATE approvals SET status='expired' WHERE status='pending'").run();
  }

  updateTask(id, status, result = null) {
    this.db.prepare("UPDATE tasks SET status=?, result=?, updated_at=? WHERE id=?").run(status, result, now(), id);
    return this.getTask(id);
  }

  bindMessage(messageId, sessionId, direction) {
    if (!messageId || !sessionId) return;
    this.db.prepare(`
      INSERT OR REPLACE INTO message_bindings(message_id, session_id, direction, created_at)
      VALUES (?, ?, ?, ?)
    `).run(messageId, sessionId, direction, now());
  }

  sessionForMessage(messageId) {
    if (!messageId) return null;
    const row = this.db.prepare(`
      SELECT s.* FROM message_bindings b JOIN sessions s ON s.id=b.session_id WHERE b.message_id=?
    `).get(messageId);
    return row || null;
  }

  createApproval({ sessionId, taskId, description, ttlMs = 600000 }) {
    const id = shortId("RQ");
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO approvals(id, session_id, task_id, description, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?)
    `).run(id, sessionId, taskId, description, timestamp, timestamp + ttlMs);
    return this.getApproval(id);
  }

  getApproval(id) {
    return this.db.prepare("SELECT * FROM approvals WHERE id=?").get(id) || null;
  }

  listPendingApprovals() {
    return this.db.prepare("SELECT * FROM approvals WHERE status='pending' AND expires_at>? ORDER BY created_at DESC").all(now());
  }

  resolveApproval(id, status) {
    const result = this.db.prepare("UPDATE approvals SET status=? WHERE id=? AND status='pending'").run(status, id);
    return Number(result.changes) === 1;
  }

  expireApprovals() {
    this.db.prepare("UPDATE approvals SET status='expired' WHERE status='pending' AND expires_at<=?").run(now());
  }

  enqueueOutbox(dedupeKey, text, sessionId = null) {
    this.db.prepare(`
      INSERT OR IGNORE INTO outbox(dedupe_key, text, session_id, created_at) VALUES (?, ?, ?, ?)
    `).run(dedupeKey, text, sessionId, now());
  }

  nextOutbox() {
    return this.db.prepare("SELECT * FROM outbox WHERE status='pending' ORDER BY id LIMIT 1").get() || null;
  }

  markOutboxSent(id, remoteMessageId = null) {
    this.db.prepare("UPDATE outbox SET status='sent', remote_message_id=?, attempts=attempts+1, sent_at=? WHERE id=?")
      .run(remoteMessageId, now(), id);
  }

  markOutboxFailed(id) {
    this.db.prepare("UPDATE outbox SET attempts=attempts+1 WHERE id=?").run(id);
  }

  close() {
    this.db.close();
  }
}
