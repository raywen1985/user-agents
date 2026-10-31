import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { projectRoot } from "./config.mjs";
import { serializeApprovalProfile } from "./approval-control.mjs";
import { normalizeExactSessionName } from "./session-name-match.mjs";

function now() {
  return Date.now();
}

function shortId(prefix) {
  const date = new Date().toISOString().slice(2, 10).replaceAll("-", "");
  return `${prefix}-${date}-${randomBytes(3).toString("hex").toUpperCase()}`;
}

function opaqueId(prefix) {
  return `${prefix}-${randomBytes(16).toString("hex").toUpperCase()}`;
}

function normalizeStopTarget(target) {
  const provider = String(target?.provider || "");
  const base = {
    provider,
    agent: target?.agent === "claude" ? "claude" : "codex",
    sessionId: String(target?.sessionId || ""),
    ...(target?.nativeId ? { nativeId: String(target.nativeId) } : {}),
  };
  if (!base.sessionId || !["gateway", "claude", "codex"].includes(provider)) {
    throw new Error("Stop target is invalid");
  }
  if (provider === "gateway") {
    const gatewayId = String(target.gatewayId || "");
    const taskIds = [...new Set((target.taskIds || []).map(String).filter(Boolean))].sort();
    if (!gatewayId || taskIds.length === 0 || taskIds.length > 200) throw new Error("Gateway stop target is invalid");
    return { ...base, gatewayId, taskIds };
  }
  if (provider === "codex") {
    const endpointId = String(target.endpointId || "");
    const turnId = String(target.turnId || "");
    if (!endpointId || !turnId) throw new Error("Codex stop target is invalid");
    return { ...base, endpointId, turnId };
  }
  const pid = Number(target.pid);
  const procStart = String(target.procStart || "");
  const sourcePath = String(target.sourcePath || "");
  if (!Number.isSafeInteger(pid) || pid <= 0 || !/^\d{10,20}$/.test(procStart) || !path.isAbsolute(sourcePath)) {
    throw new Error("Claude stop target is invalid");
  }
  return { ...base, pid, procStart, sourcePath };
}

function targetKey(target) {
  return createHash("sha256").update(JSON.stringify(target)).digest("hex");
}

function parseJson(value, fallback = null) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function projectKey(value) {
  return path.resolve(String(value || "")).replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
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
        message_type TEXT NOT NULL DEFAULT 'text',
        status TEXT NOT NULL DEFAULT 'received',
        received_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS off_work_requests (
        message_id TEXT PRIMARY KEY, state TEXT NOT NULL, result_json TEXT, reply_text TEXT,
        inbox_cutoff INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
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
        approval_profile_json TEXT,
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
        operation_class TEXT,
        grant_eligible INTEGER NOT NULL DEFAULT 0 CHECK (grant_eligible IN (0, 1)),
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dedupe_key TEXT NOT NULL UNIQUE,
        text TEXT NOT NULL,
        session_id TEXT,
        approval_id TEXT REFERENCES approvals(id),
        status TEXT NOT NULL DEFAULT 'pending',
        remote_message_id TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        sent_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS approval_prompt_bindings (
        message_id TEXT PRIMARY KEY,
        approval_id TEXT NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        session_id TEXT NOT NULL REFERENCES sessions(id),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS gateway_instance_owner (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id=1),
        pid INTEGER NOT NULL,
        proc_start TEXT NOT NULL,
        epoch TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('running', 'draining')),
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_stop_targets (
        stop_ref TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK (provider IN ('gateway', 'claude', 'codex')),
        agent TEXT NOT NULL CHECK (agent IN ('claude', 'codex')),
        session_id TEXT NOT NULL,
        provider_target_key TEXT NOT NULL,
        target_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_stop_targets_expiry_idx ON agent_stop_targets(expires_at, created_at);
      CREATE TABLE IF NOT EXISTS agent_stop_operations (
        id TEXT PRIMARY KEY,
        provider_target_key TEXT NOT NULL,
        active_operation_key TEXT UNIQUE,
        provider TEXT NOT NULL CHECK (provider IN ('gateway', 'claude', 'codex')),
        agent TEXT NOT NULL CHECK (agent IN ('claude', 'codex')),
        session_id TEXT NOT NULL,
        target_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'signaling', 'completed', 'uncertain')),
        outcome TEXT,
        reply_text TEXT,
        ever_signaled INTEGER NOT NULL DEFAULT 0 CHECK (ever_signaled IN (0, 1)),
        owner_epoch TEXT,
        owner_token TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS agent_stop_operations_state_idx ON agent_stop_operations(state, updated_at);
      CREATE INDEX IF NOT EXISTS agent_stop_operations_target_idx ON agent_stop_operations(provider_target_key, created_at DESC);
      CREATE TABLE IF NOT EXISTS agent_stop_ref_claims (
        stop_ref TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL REFERENCES agent_stop_operations(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_stop_requests (
        message_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL REFERENCES agent_stop_operations(id) ON DELETE CASCADE,
        stop_ref TEXT NOT NULL,
        outbox_dedupe_key TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_stop_requests_operation_idx ON agent_stop_requests(operation_id, created_at);
      CREATE TABLE IF NOT EXISTS native_session_claims (
        executor TEXT NOT NULL CHECK (executor IN ('claude', 'codex')),
        native_id TEXT NOT NULL,
        session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),
        created_at INTEGER NOT NULL,
        PRIMARY KEY(executor, native_id)
      );
      CREATE TABLE IF NOT EXISTS native_session_claim_conflicts (
        executor TEXT NOT NULL,
        native_id TEXT NOT NULL,
        session_ids_json TEXT NOT NULL,
        resolved_at INTEGER,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(executor, native_id)
      );
      CREATE TABLE IF NOT EXISTS session_name_claims (
        executor TEXT NOT NULL CHECK (executor IN ('claude', 'codex')),
        project_key TEXT NOT NULL,
        compact_name TEXT NOT NULL,
        session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),
        created_at INTEGER NOT NULL,
        PRIMARY KEY(executor, project_key, compact_name)
      );
      CREATE TABLE IF NOT EXISTS session_name_claim_conflicts (
        executor TEXT NOT NULL,
        project_key TEXT NOT NULL,
        compact_name TEXT NOT NULL,
        session_ids_json TEXT NOT NULL,
        resolved_at INTEGER,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(executor, project_key, compact_name)
      );
      CREATE TABLE IF NOT EXISTS session_exact_name_claims (
        executor TEXT NOT NULL CHECK (executor IN ('claude', 'codex')),
        exact_name TEXT NOT NULL,
        session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),
        created_at INTEGER NOT NULL,
        PRIMARY KEY(executor, exact_name)
      );
      CREATE TABLE IF NOT EXISTS session_exact_name_claim_conflicts (
        executor TEXT NOT NULL CHECK (executor IN ('claude', 'codex')),
        exact_name TEXT NOT NULL,
        session_ids_json TEXT NOT NULL,
        resolved_at INTEGER,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(executor, exact_name)
      );
      CREATE TABLE IF NOT EXISTS session_lookup_requests (
        message_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('pending', 'selection', 'committed', 'failed')),
        executor TEXT,
        project_alias TEXT,
        project_path TEXT,
        session_name TEXT NOT NULL,
        auto_name INTEGER NOT NULL DEFAULT 0 CHECK (auto_name IN (0, 1)),
        content TEXT NOT NULL,
        approval_profile_json TEXT,
        decision TEXT,
        session_id TEXT,
        task_id TEXT,
        candidate_set_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_candidate_sets (
        id TEXT PRIMARY KEY,
        request_message_id TEXT NOT NULL REFERENCES session_lookup_requests(message_id),
        kind TEXT NOT NULL DEFAULT 'session-choice' CHECK (kind IN ('session-choice', 'executor-choice', 'project-choice')),
        candidates_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('open', 'transitioned', 'superseded', 'consumed', 'expired')),
        parent_set_id TEXT REFERENCES session_candidate_sets(id),
        transition_set_id TEXT REFERENCES session_candidate_sets(id),
        replaces_set_id TEXT REFERENCES session_candidate_sets(id),
        replacement_set_id TEXT REFERENCES session_candidate_sets(id),
        active_page_id TEXT,
        selected_index INTEGER,
        selection_message_id TEXT UNIQUE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS session_candidate_sets_request_idx
        ON session_candidate_sets(request_message_id, created_at);
      CREATE TABLE IF NOT EXISTS session_candidate_pages (
        id TEXT PRIMARY KEY,
        candidate_set_id TEXT NOT NULL REFERENCES session_candidate_sets(id) ON DELETE CASCADE,
        snapshot_version INTEGER NOT NULL DEFAULT 1,
        page_number INTEGER NOT NULL,
        candidates_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        sent_at INTEGER,
        UNIQUE(candidate_set_id, snapshot_version, page_number)
      );
      CREATE TABLE IF NOT EXISTS session_candidate_message_bindings (
        message_id TEXT PRIMARY KEY,
        candidate_set_id TEXT NOT NULL REFERENCES session_candidate_sets(id),
        candidate_page_id TEXT REFERENCES session_candidate_pages(id),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recent_session_contexts (
        chat_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        executor TEXT NOT NULL CHECK (executor IN ('claude', 'codex')),
        project_alias TEXT NOT NULL,
        project_path TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(chat_id, sender_id)
      );
      CREATE TABLE IF NOT EXISTS project_authorities (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        project_key TEXT NOT NULL,
        project_path TEXT NOT NULL,
        source_type TEXT NOT NULL CHECK (source_type IN ('native', 'override')),
        provider TEXT CHECK (provider IN ('claude', 'codex') OR provider IS NULL),
        native_id TEXT,
        source_path TEXT,
        override_alias TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS project_authorities_project_idx ON project_authorities(project_key);
    `);
    const inboxColumns = new Set(this.db.prepare("PRAGMA table_info(inbox)").all().map((row) => row.name));
    if (!inboxColumns.has("message_type")) this.db.exec("ALTER TABLE inbox ADD COLUMN message_type TEXT NOT NULL DEFAULT 'text'");
    const lookupColumns = new Set(this.db.prepare("PRAGMA table_info(session_lookup_requests)").all().map((row) => row.name));
    if (!lookupColumns.has("auto_name")) this.db.exec("ALTER TABLE session_lookup_requests ADD COLUMN auto_name INTEGER NOT NULL DEFAULT 0 CHECK (auto_name IN (0, 1))");
    if (!lookupColumns.has("approval_profile_json")) this.db.exec("ALTER TABLE session_lookup_requests ADD COLUMN approval_profile_json TEXT");
    const taskColumns = new Set(this.db.prepare("PRAGMA table_info(tasks)").all().map((row) => row.name));
    if (!taskColumns.has("approval_profile_json")) this.db.exec("ALTER TABLE tasks ADD COLUMN approval_profile_json TEXT");
    const approvalColumns = new Set(this.db.prepare("PRAGMA table_info(approvals)").all().map((row) => row.name));
    if (!approvalColumns.has("operation_class")) this.db.exec("ALTER TABLE approvals ADD COLUMN operation_class TEXT");
    if (!approvalColumns.has("grant_eligible")) this.db.exec("ALTER TABLE approvals ADD COLUMN grant_eligible INTEGER NOT NULL DEFAULT 0 CHECK (grant_eligible IN (0, 1))");
    const outboxColumns = new Set(this.db.prepare("PRAGMA table_info(outbox)").all().map((row) => row.name));
    if (!outboxColumns.has("candidate_set_id")) this.db.exec("ALTER TABLE outbox ADD COLUMN candidate_set_id TEXT");
    if (!outboxColumns.has("candidate_page_id")) this.db.exec("ALTER TABLE outbox ADD COLUMN candidate_page_id TEXT");
    if (!outboxColumns.has("approval_id")) this.db.exec("ALTER TABLE outbox ADD COLUMN approval_id TEXT REFERENCES approvals(id)");
    this.#migrateCandidateSchema();
    this.#backfillSessionClaims();
  }

  #migrateCandidateSchema() {
    const setColumns = new Set(this.db.prepare("PRAGMA table_info(session_candidate_sets)").all().map((row) => row.name));
    const bindingColumns = new Set(this.db.prepare("PRAGMA table_info(session_candidate_message_bindings)").all().map((row) => row.name));
    if (setColumns.has("kind") && setColumns.has("parent_set_id") && bindingColumns.has("candidate_page_id")) return;

    this.db.exec("PRAGMA foreign_keys=OFF");
    try {
      this.db.exec(`
        BEGIN IMMEDIATE;
        DROP TABLE IF EXISTS session_candidate_pages;
        DROP INDEX IF EXISTS session_candidate_sets_request_idx;
        ALTER TABLE session_candidate_message_bindings RENAME TO session_candidate_message_bindings_legacy;
        ALTER TABLE session_candidate_sets RENAME TO session_candidate_sets_legacy;
        CREATE TABLE session_candidate_sets (
          id TEXT PRIMARY KEY,
          request_message_id TEXT NOT NULL REFERENCES session_lookup_requests(message_id),
          kind TEXT NOT NULL CHECK (kind IN ('session-choice', 'executor-choice', 'project-choice')),
          candidates_json TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('open', 'transitioned', 'superseded', 'consumed', 'expired')),
          parent_set_id TEXT REFERENCES session_candidate_sets(id),
          transition_set_id TEXT REFERENCES session_candidate_sets(id),
          replaces_set_id TEXT REFERENCES session_candidate_sets(id),
          replacement_set_id TEXT REFERENCES session_candidate_sets(id),
          active_page_id TEXT,
          selected_index INTEGER,
          selection_message_id TEXT UNIQUE,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          consumed_at INTEGER
        );
        CREATE INDEX session_candidate_sets_request_idx
          ON session_candidate_sets(request_message_id, created_at);
        INSERT INTO session_candidate_sets(
          id, request_message_id, kind, candidates_json, state, selected_index,
          selection_message_id, created_at, expires_at, consumed_at
        )
        SELECT id, request_message_id, 'session-choice', candidates_json,
          CASE WHEN state='consumed' THEN 'consumed' ELSE 'expired' END,
          selected_index, selection_message_id, created_at, expires_at, consumed_at
        FROM session_candidate_sets_legacy;
        CREATE TABLE session_candidate_pages (
          id TEXT PRIMARY KEY,
          candidate_set_id TEXT NOT NULL REFERENCES session_candidate_sets(id) ON DELETE CASCADE,
          snapshot_version INTEGER NOT NULL DEFAULT 1,
          page_number INTEGER NOT NULL,
          candidates_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          sent_at INTEGER,
          UNIQUE(candidate_set_id, snapshot_version, page_number)
        );
        CREATE TABLE session_candidate_message_bindings (
          message_id TEXT PRIMARY KEY,
          candidate_set_id TEXT NOT NULL REFERENCES session_candidate_sets(id),
          candidate_page_id TEXT REFERENCES session_candidate_pages(id),
          created_at INTEGER NOT NULL
        );
        INSERT INTO session_candidate_message_bindings(message_id, candidate_set_id, candidate_page_id, created_at)
        SELECT message_id, candidate_set_id, NULL, created_at
        FROM session_candidate_message_bindings_legacy;
        DROP TABLE session_candidate_message_bindings_legacy;
        DROP TABLE session_candidate_sets_legacy;
        COMMIT;
      `);
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    } finally {
      this.db.exec("PRAGMA foreign_keys=ON");
    }
  }

  #backfillSessionClaims() {
    const timestamp = now();
    const nativeGroups = this.db.prepare(`
      SELECT executor, lower(native_id) AS native_id, group_concat(id) AS ids, count(*) AS total
      FROM sessions WHERE status <> 'archived' AND native_id IS NOT NULL AND trim(native_id) <> ''
      GROUP BY executor, lower(native_id)
    `).all();
    for (const group of nativeGroups) {
      const ids = String(group.ids).split(",").sort();
      if (Number(group.total) === 1) {
        this.db.prepare("INSERT OR IGNORE INTO native_session_claims VALUES (?, ?, ?, ?)")
          .run(group.executor, group.native_id, ids[0], timestamp);
      } else {
        this.db.prepare(`INSERT OR IGNORE INTO native_session_claim_conflicts VALUES (?, ?, ?, NULL, ?)`)
          .run(group.executor, group.native_id, JSON.stringify(ids), timestamp);
      }
    }
    const sessions = this.db.prepare("SELECT * FROM sessions WHERE status <> 'archived'").all();
    const groups = new Map();
    for (const session of sessions) {
      const normalized = normalizeExactSessionName(session.name);
      if (!normalized) continue;
      const key = `${session.executor}\u0000${normalized.key}`;
      const group = groups.get(key) || [];
      group.push(session);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      const first = group[0];
      const normalized = normalizeExactSessionName(first.name);
      const ids = group.map((item) => item.id).sort();
      if (group.length === 1) {
        this.db.prepare("INSERT OR IGNORE INTO session_exact_name_claims VALUES (?, ?, ?, ?)")
          .run(first.executor, normalized.key, first.id, timestamp);
      } else {
        this.db.prepare(`INSERT OR IGNORE INTO session_exact_name_claim_conflicts VALUES (?, ?, ?, NULL, ?)`)
          .run(first.executor, normalized.key, JSON.stringify(ids), timestamp);
      }
    }
  }

  #transaction(run) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  acceptInbox(event) {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO inbox(message_id, sender_id, chat_id, reply_to, content, message_type, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(event.message_id, event.sender_id, event.chat_id, event.reply_to || null, event.content,
      event.message_type || "text", now());
    return Number(result.changes) === 1;
  }

  claimOffWork(messageId) {
    return this.#transaction(() => {
      const existing = this.db.prepare('SELECT * FROM off_work_requests WHERE message_id=?').get(messageId);
      if (existing) return { ownsExecution: false, ...existing };
      this.db.prepare(`INSERT INTO off_work_requests(message_id,state,inbox_cutoff,created_at,updated_at)
        VALUES (?,'running',(SELECT COALESCE(MAX(rowid),0) FROM inbox),?,?)`).run(messageId, now(), now());
      this.db.prepare(`UPDATE sessions SET status='cancelled',last_summary='下班取消排队任务',updated_at=?
        WHERE id IN (SELECT session_id FROM tasks WHERE status='queued')`).run(now());
      this.db.prepare("UPDATE tasks SET status='cancelled',result='下班取消排队任务',updated_at=? WHERE status='queued'").run(now());
      return { ownsExecution: true, message_id: messageId, state: 'running' };
    });
  }

  finishOffWork(messageId, result, text) {
    this.db.prepare(`UPDATE off_work_requests SET state='finished',result_json=?,reply_text=?,
      inbox_cutoff=(SELECT COALESCE(MAX(rowid),0) FROM inbox),updated_at=? WHERE message_id=?`)
      .run(JSON.stringify(result), text, now(), messageId);
  }

  recoverOffWorkRequests() {
    const requests = this.db.prepare("SELECT message_id FROM off_work_requests WHERE state='running'").all();
    for (const request of requests) this.finishOffWork(request.message_id, { status: 'uncertain', released: false },
      '下班执行期间网关中断，无法确认最终结果；不会自动再次关闭客户端。请发送“下班检查”。');
    return requests.length;
  }

  taskBlockedByOffWork(messageId) {
    if (this.taskAdmissionBlocked) return true;
    if (!messageId) return false;
    return Boolean(this.db.prepare(`SELECT 1 FROM inbox WHERE message_id=? AND rowid <=
      (SELECT MAX(inbox_cutoff) FROM off_work_requests)`).get(messageId));
  }

  markInbox(messageId, status) {
    this.db.prepare("UPDATE inbox SET status=? WHERE message_id=?").run(status, messageId);
  }

  listPendingInbox(limit = 1000) {
    return this.db.prepare(`
      SELECT message_id, sender_id, chat_id, reply_to, content, message_type
      FROM inbox WHERE status='received' ORDER BY received_at, message_id LIMIT ?
    `).all(limit);
  }

  beginSessionLookup({
    messageId, executor = null, project = null, projectQuery = null, sessionName, content,
    autoName = false, approvalProfile = null,
  }) {
    const timestamp = now();
    this.db.prepare(`
      INSERT OR IGNORE INTO session_lookup_requests(
        message_id, state, executor, project_alias, project_path, session_name, auto_name,
        content, approval_profile_json, created_at, updated_at
      ) VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(messageId, executor, project?.alias || projectQuery || null, project?.path || null,
      sessionName, autoName ? 1 : 0, content, serializeApprovalProfile(approvalProfile), timestamp, timestamp);
    return this.getSessionLookup(messageId);
  }

  getSessionLookup(messageId) {
    return this.db.prepare("SELECT * FROM session_lookup_requests WHERE message_id=?").get(messageId) || null;
  }

  createCandidateSet({ messageId, candidates, kind = "session-choice", ttlMs = 30 * 60 * 1000, pageSize = 10, outbox = null }) {
    if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > 20000
      || !["session-choice", "executor-choice", "project-choice"].includes(kind)
      || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 10) throw new Error("Candidate set is invalid");
    const timestamp = now();
    return this.#transaction(() => {
      const existing = this.db.prepare(`
        SELECT * FROM session_candidate_sets
        WHERE request_message_id=? AND parent_set_id IS NULL AND replaces_set_id IS NULL
        ORDER BY created_at DESC LIMIT 1
      `).get(messageId);
      if (existing) {
        const hydrated = this.#hydrateCandidateSet(existing);
        if (outbox) this.#enqueueCandidateOutbox(outbox, hydrated.id, hydrated.page?.id);
        return hydrated;
      }
      const lookup = this.getSessionLookup(messageId);
      if (!lookup || lookup.state !== "pending") throw new Error("Session lookup is not pending");
      const id = opaqueId("CS");
      const serialized = JSON.stringify(candidates);
      if (Buffer.byteLength(serialized) > 16 * 1024 * 1024) throw new Error("Candidate set is too large");
      const scope = this.db.prepare("SELECT chat_id, sender_id FROM inbox WHERE message_id=?").get(messageId);
      const replaced = scope ? this.db.prepare(`
        SELECT s.id FROM session_candidate_sets s
        JOIN session_lookup_requests r ON r.message_id=s.request_message_id
        JOIN inbox i ON i.message_id=r.message_id
        WHERE s.state='open' AND s.kind=? AND r.message_id<>? AND i.chat_id=? AND i.sender_id=?
        ORDER BY s.created_at DESC, s.id ASC LIMIT 1
      `).get(kind, messageId, scope.chat_id, scope.sender_id) : null;
      this.db.prepare(`
        INSERT INTO session_candidate_sets(
          id, request_message_id, kind, candidates_json, state, replaces_set_id, created_at, expires_at
        ) VALUES (?, ?, ?, ?, 'open', ?, ?, ?)
      `).run(id, messageId, kind, serialized, replaced?.id || null, timestamp, timestamp + ttlMs);
      if (scope) this.db.prepare(`
        UPDATE session_candidate_sets SET state='superseded', replacement_set_id=?
        WHERE id IN (
          SELECT s.id FROM session_candidate_sets s
          JOIN session_lookup_requests r ON r.message_id=s.request_message_id
          JOIN inbox i ON i.message_id=r.message_id
          WHERE s.state='open' AND s.kind=? AND r.message_id<>? AND i.chat_id=? AND i.sender_id=?
        )
      `).run(id, kind, messageId, scope.chat_id, scope.sender_id);
      const page = this.#createCandidatePage(id, this.#candidatePage(candidates, kind, 0, pageSize), 0, timestamp);
      this.db.prepare("UPDATE session_candidate_sets SET active_page_id=? WHERE id=?").run(page.id, id);
      this.db.prepare(`
        UPDATE session_lookup_requests SET state='selection', candidate_set_id=?, decision='selection', updated_at=?
        WHERE message_id=? AND state='pending'
      `).run(id, timestamp, messageId);
      this.db.prepare("UPDATE inbox SET status='waiting_selection' WHERE message_id=? AND status='received'").run(messageId);
      if (outbox) this.#enqueueCandidateOutbox(outbox, id, page.id);
      return this.#hydrateCandidateSet(this.db.prepare("SELECT * FROM session_candidate_sets WHERE id=?").get(id));
    });
  }

  transitionCandidateSet({
    parentSetId,
    candidatePageId = null,
    selectionMessageId,
    selectedIndex,
    candidate,
    kind,
    candidates,
    ttlMs = 30 * 60 * 1000,
    pageSize = 10,
    outbox = null,
  }) {
    if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > 20000
      || !["executor-choice", "project-choice"].includes(kind)) throw new Error("Child candidate set is invalid");
    return this.#transaction(() => {
      const parent = this.db.prepare("SELECT * FROM session_candidate_sets WHERE id=?").get(parentSetId);
      if (!parent) return { ok: false, reason: "selection_expired" };
      if (parent.state === "transitioned" && parent.transition_set_id) {
        const existing = this.db.prepare("SELECT * FROM session_candidate_sets WHERE id=?").get(parent.transition_set_id);
        const hydrated = this.#hydrateCandidateSet(existing);
        if (outbox) this.#enqueueCandidateOutbox(outbox, hydrated.id, hydrated.page?.id);
        return { ok: true, repeated: true, set: hydrated };
      }
      const timestamp = now();
      if (parent.state !== "open" || Number(parent.expires_at) <= timestamp) {
        this.db.prepare("UPDATE session_candidate_sets SET state='expired' WHERE id=? AND state='open'").run(parentSetId);
        return { ok: false, reason: "selection_expired" };
      }
      const pageId = candidatePageId || parent.active_page_id;
      const page = this.db.prepare(`
        SELECT * FROM session_candidate_pages WHERE id=? AND candidate_set_id=?
      `).get(pageId, parentSetId);
      const visible = parseJson(page?.candidates_json || "[]", []);
      if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= visible.length
        || visible[selectedIndex]?.identity !== candidate?.identity) return { ok: false, reason: "stale_target" };

      const childId = opaqueId("CS");
      const serialized = JSON.stringify(candidates);
      if (Buffer.byteLength(serialized) > 16 * 1024 * 1024) throw new Error("Candidate set is too large");
      const scope = this.db.prepare(`
        SELECT i.chat_id, i.sender_id FROM inbox i WHERE i.message_id=?
      `).get(parent.request_message_id);
      const replaced = scope ? this.db.prepare(`
        SELECT s.id FROM session_candidate_sets s
        JOIN session_lookup_requests r ON r.message_id=s.request_message_id
        JOIN inbox i ON i.message_id=r.message_id
        WHERE s.state='open' AND s.kind=? AND s.id<>? AND i.chat_id=? AND i.sender_id=?
        ORDER BY s.created_at DESC, s.id ASC LIMIT 1
      `).get(kind, parentSetId, scope.chat_id, scope.sender_id) : null;
      this.db.prepare(`
        INSERT INTO session_candidate_sets(
          id, request_message_id, kind, candidates_json, state, parent_set_id,
          replaces_set_id, created_at, expires_at
        ) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)
      `).run(childId, parent.request_message_id, kind, serialized, parentSetId,
        replaced?.id || null, timestamp, timestamp + ttlMs);
      if (scope) this.db.prepare(`
        UPDATE session_candidate_sets SET state='superseded', replacement_set_id=?
        WHERE id IN (
          SELECT s.id FROM session_candidate_sets s
          JOIN session_lookup_requests r ON r.message_id=s.request_message_id
          JOIN inbox i ON i.message_id=r.message_id
          WHERE s.state='open' AND s.kind=? AND s.id<>? AND i.chat_id=? AND i.sender_id=?
        )
      `).run(childId, kind, childId, scope.chat_id, scope.sender_id);
      const childPage = this.#createCandidatePage(childId, this.#candidatePage(candidates, kind, 0, pageSize), 0, timestamp);
      this.db.prepare("UPDATE session_candidate_sets SET active_page_id=? WHERE id=?").run(childPage.id, childId);
      const changed = this.db.prepare(`
        UPDATE session_candidate_sets
        SET state='transitioned', transition_set_id=?, selected_index=?, selection_message_id=?, consumed_at=?
        WHERE id=? AND state='open'
      `).run(childId, selectedIndex, selectionMessageId, timestamp, parentSetId);
      if (Number(changed.changes) !== 1) throw new Error("Candidate transition race");
      this.db.prepare(`
        UPDATE session_lookup_requests SET candidate_set_id=?, updated_at=? WHERE message_id=?
      `).run(childId, timestamp, parent.request_message_id);
      if (outbox) this.#enqueueCandidateOutbox(outbox, childId, childPage.id);
      return {
        ok: true,
        set: this.#hydrateCandidateSet(this.db.prepare("SELECT * FROM session_candidate_sets WHERE id=?").get(childId)),
      };
    });
  }

  replaceCandidateSet({
    replacedSetId,
    candidatePageId = null,
    selectedIndex,
    candidate,
    candidates,
    kind = "session-choice",
    ttlMs = 30 * 60 * 1000,
    pageSize = 10,
    outbox = null,
  }) {
    if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > 20000
      || !["session-choice", "executor-choice", "project-choice"].includes(kind)) {
      throw new Error("Replacement candidate set is invalid");
    }
    return this.#transaction(() => {
      const replaced = this.db.prepare("SELECT * FROM session_candidate_sets WHERE id=?").get(replacedSetId);
      if (!replaced) return { ok: false, reason: "selection_expired" };
      if (replaced.state === "superseded" && replaced.replacement_set_id) {
        const existing = this.#hydrateCandidateSet(
          this.db.prepare("SELECT * FROM session_candidate_sets WHERE id=?").get(replaced.replacement_set_id));
        if (outbox) this.#enqueueCandidateOutbox(outbox, existing.id, existing.page?.id);
        return { ok: true, repeated: true, set: existing };
      }
      const timestamp = now();
      if (replaced.state !== "open" || Number(replaced.expires_at) <= timestamp) {
        return { ok: false, reason: "selection_expired" };
      }
      const pageId = candidatePageId || replaced.active_page_id;
      const page = this.db.prepare(`
        SELECT * FROM session_candidate_pages WHERE id=? AND candidate_set_id=?
      `).get(pageId, replacedSetId);
      const visible = parseJson(page?.candidates_json || "[]", []);
      if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= visible.length
        || visible[selectedIndex]?.identity !== candidate?.identity) return { ok: false, reason: "stale_target" };

      const id = opaqueId("CS");
      const serialized = JSON.stringify(candidates);
      if (Buffer.byteLength(serialized) > 16 * 1024 * 1024) throw new Error("Candidate set is too large");
      this.db.prepare(`
        INSERT INTO session_candidate_sets(
          id, request_message_id, kind, candidates_json, state, parent_set_id,
          replaces_set_id, created_at, expires_at
        ) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)
      `).run(id, replaced.request_message_id, kind, serialized, replaced.parent_set_id,
        replacedSetId, timestamp, timestamp + ttlMs);
      const replacementPage = this.#createCandidatePage(
        id, this.#candidatePage(candidates, kind, 0, pageSize), 0, timestamp);
      this.db.prepare("UPDATE session_candidate_sets SET active_page_id=? WHERE id=?")
        .run(replacementPage.id, id);
      this.db.prepare(`
        UPDATE session_candidate_sets SET state='superseded', replacement_set_id=?
        WHERE id=? AND state='open'
      `).run(id, replacedSetId);
      if (replaced.parent_set_id) this.db.prepare(`
        UPDATE session_candidate_sets SET transition_set_id=? WHERE id=? AND transition_set_id=?
      `).run(id, replaced.parent_set_id, replacedSetId);
      this.db.prepare(`
        UPDATE session_lookup_requests SET candidate_set_id=?, updated_at=? WHERE message_id=?
      `).run(id, timestamp, replaced.request_message_id);
      if (outbox) this.#enqueueCandidateOutbox(outbox, id, replacementPage.id);
      return {
        ok: true,
        set: this.#hydrateCandidateSet(
          this.db.prepare("SELECT * FROM session_candidate_sets WHERE id=?").get(id), replacementPage),
      };
    });
  }

  #enqueueCandidateOutbox(outbox, candidateSetId, candidatePageId) {
    if (!outbox?.dedupeKey || !outbox?.text) throw new Error("Candidate outbox is invalid");
    this.db.prepare(`
      INSERT OR IGNORE INTO outbox(
        dedupe_key, text, candidate_set_id, candidate_page_id, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(outbox.dedupeKey, outbox.text, candidateSetId, candidatePageId, now());
  }

  #createCandidatePage(candidateSetId, candidates, pageNumber, timestamp = now()) {
    const serialized = JSON.stringify(candidates);
    if (Buffer.byteLength(serialized) > 1024 * 1024) throw new Error("Candidate page is too large");
    const id = opaqueId("CP");
    this.db.prepare(`
      INSERT INTO session_candidate_pages(
        id, candidate_set_id, snapshot_version, page_number, candidates_json, created_at
      ) VALUES (?, ?, 1, ?, ?, ?)
    `).run(id, candidateSetId, pageNumber, serialized, timestamp);
    return this.db.prepare("SELECT * FROM session_candidate_pages WHERE id=?").get(id);
  }

  #candidatePage(candidates, kind, pageNumber, pageSize = 10) {
    if (kind === "session-choice" && candidates.at(-1)?.kind === "create-new") {
      const sessions = candidates.slice(0, -1);
      const start = pageNumber * (pageSize - 1);
      return [...sessions.slice(start, start + pageSize - 1), candidates.at(-1)];
    }
    const start = pageNumber * pageSize;
    return candidates.slice(start, start + pageSize);
  }

  candidatePageCount(candidateSet) {
    const candidates = candidateSet?.allCandidates || parseJson(candidateSet?.candidates_json || "[]", []);
    if (!candidates.length) return 0;
    if (candidateSet.kind === "session-choice" && candidates.at(-1)?.kind === "create-new") {
      return Math.max(1, Math.ceil((candidates.length - 1) / 9));
    }
    return Math.ceil(candidates.length / 10);
  }

  navigateCandidatePage({ candidateSetId, direction, renderOutbox = null }) {
    return this.#transaction(() => {
      const row = this.db.prepare("SELECT * FROM session_candidate_sets WHERE id=?").get(candidateSetId);
      if (!row || row.state !== "open" || Number(row.expires_at) <= now()) {
        if (row?.state === "open") this.db.prepare("UPDATE session_candidate_sets SET state='expired' WHERE id=?").run(candidateSetId);
        return { ok: false, reason: "selection_expired" };
      }
      const current = row.active_page_id
        ? this.db.prepare("SELECT * FROM session_candidate_pages WHERE id=?").get(row.active_page_id)
        : null;
      const allCandidates = parseJson(row.candidates_json, []);
      const hydrated = this.#hydrateCandidateSet(row, current);
      const totalPages = this.candidatePageCount(hydrated);
      const delta = direction === "next" ? 1 : direction === "previous" ? -1 : 0;
      const targetNumber = Number(current?.page_number || 0) + delta;
      if (!delta || targetNumber < 0 || targetNumber >= totalPages) {
        return { ok: false, reason: "page_range", pageNumber: Number(current?.page_number || 0), totalPages };
      }
      let page = this.db.prepare(`
        SELECT * FROM session_candidate_pages
        WHERE candidate_set_id=? AND snapshot_version=1 AND page_number=?
      `).get(candidateSetId, targetNumber);
      if (!page) page = this.#createCandidatePage(candidateSetId,
        this.#candidatePage(allCandidates, row.kind, targetNumber, 10), targetNumber);
      this.db.prepare("UPDATE session_candidate_sets SET active_page_id=? WHERE id=?").run(page.id, candidateSetId);
      const set = this.#hydrateCandidateSet(
        this.db.prepare("SELECT * FROM session_candidate_sets WHERE id=?").get(candidateSetId), page);
      const outbox = renderOutbox ? renderOutbox(set, totalPages) : null;
      if (outbox) this.#enqueueCandidateOutbox(outbox, candidateSetId, page.id);
      return {
        ok: true,
        set,
        totalPages,
        outbox,
      };
    });
  }

  #hydrateCandidateSet(row, page = null) {
    if (!row) return null;
    const activePage = page || (row.active_page_id
      ? this.db.prepare("SELECT * FROM session_candidate_pages WHERE id=?").get(row.active_page_id)
      : null);
    return {
      ...row,
      candidates: parseJson(activePage?.candidates_json || row.candidates_json, []),
      allCandidates: parseJson(row.candidates_json, []),
      page: activePage || null,
    };
  }

  bindCandidateMessage(messageId, candidateSetId, candidatePageId = null) {
    if (!messageId || !candidateSetId) return;
    const set = this.db.prepare("SELECT * FROM session_candidate_sets WHERE id=?").get(candidateSetId);
    const pageId = candidatePageId || set?.active_page_id || null;
    if (pageId) this.db.prepare("UPDATE session_candidate_pages SET sent_at=COALESCE(sent_at, ?) WHERE id=? AND candidate_set_id=?")
      .run(now(), pageId, candidateSetId);
    this.db.prepare(`
      INSERT OR REPLACE INTO session_candidate_message_bindings(
        message_id, candidate_set_id, candidate_page_id, created_at
      ) VALUES (?, ?, ?, ?)
    `).run(messageId, candidateSetId, pageId, now());
  }

  candidateSetForReply(messageId) {
    if (!messageId) return null;
    const row = this.db.prepare(`
      SELECT s.*, r.executor, r.project_alias, r.project_path, r.session_name, r.auto_name, r.content,
        p.id AS page_id, p.page_number, p.snapshot_version, p.candidates_json AS page_candidates_json
      FROM session_candidate_message_bindings b
      JOIN session_candidate_sets s ON s.id=b.candidate_set_id
      JOIN session_lookup_requests r ON r.message_id=s.request_message_id
      LEFT JOIN session_candidate_pages p ON p.id=b.candidate_page_id
      WHERE b.message_id=?
    `).get(messageId);
    return row ? { ...row, candidates: parseJson(row.page_candidates_json || row.candidates_json, []) } : null;
  }

  candidateSetForStandaloneNumber({ chatId, senderId, timestamp = now() }) {
    if (!chatId || !senderId) return { kind: "none" };
    const rows = this.db.prepare(`
      SELECT s.*, r.executor, r.project_alias, r.project_path, r.session_name, r.auto_name, r.content,
        p.id AS page_id, p.page_number, p.snapshot_version, p.candidates_json AS page_candidates_json
      FROM session_candidate_sets s
      JOIN session_lookup_requests r ON r.message_id=s.request_message_id
      JOIN inbox i ON i.message_id=s.request_message_id
      JOIN session_candidate_pages p ON p.id=s.active_page_id AND p.sent_at IS NOT NULL
      WHERE s.state='open' AND s.expires_at>? AND i.chat_id=? AND i.sender_id=?
        AND NOT EXISTS (
          SELECT 1 FROM session_candidate_sets child
          WHERE child.parent_set_id=s.id AND child.state='open'
        )
      ORDER BY s.created_at DESC, s.id ASC
      LIMIT 2
    `).all(timestamp, chatId, senderId);
    if (rows.length === 0) return { kind: "none" };
    if (rows.length > 1) return { kind: "ambiguous" };
    const binding = rows[0];
    return { kind: "selected", binding: { ...binding, candidates: parseJson(binding.page_candidates_json || binding.candidates_json, []) } };
  }

  failSessionLookup(messageId, decision = "failed") {
    this.db.prepare(`UPDATE session_lookup_requests SET state='failed', decision=?, updated_at=? WHERE message_id=? AND state='pending'`)
      .run(decision, now(), messageId);
  }

  #claimName(session) {
    const normalized = normalizeExactSessionName(session.name);
    if (!normalized) return { ok: false, reason: "invalid_name" };
    const conflict = this.db.prepare(`
      SELECT 1 FROM session_exact_name_claim_conflicts
      WHERE executor=? AND exact_name=? AND resolved_at IS NULL
    `).get(session.executor, normalized.key);
    if (conflict) return { ok: false, reason: "name_claim_conflict" };
    const claim = this.db.prepare(`
      SELECT session_id FROM session_exact_name_claims WHERE executor=? AND exact_name=?
    `).get(session.executor, normalized.key);
    if (claim && claim.session_id !== session.id) return { ok: false, reason: "name_in_use", sessionId: claim.session_id };
    if (!claim) this.db.prepare("INSERT INTO session_exact_name_claims VALUES (?, ?, ?, ?)")
      .run(session.executor, normalized.key, session.id, now());
    return { ok: true };
  }

  #recordProjectAuthority(session, project, authority) {
    if (!session || !project?.path || !authority || !["native", "override"].includes(authority.sourceType)) return;
    const sourceType = authority.sourceType;
    const provider = sourceType === "native" && ["claude", "codex"].includes(authority.provider) ? authority.provider : null;
    const nativeId = sourceType === "native" ? String(authority.nativeId || "").toLowerCase() : null;
    const sourcePath = authority.sourcePath ? String(authority.sourcePath) : null;
    const overrideAlias = sourceType === "override" ? String(authority.overrideAlias || project.alias || "") : null;
    if (sourceType === "native" && !nativeId) return;
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO project_authorities(
        session_id, project_key, project_path, source_type, provider, native_id,
        source_path, override_alias, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        project_key=excluded.project_key,
        project_path=excluded.project_path,
        source_type=excluded.source_type,
        provider=excluded.provider,
        native_id=excluded.native_id,
        source_path=excluded.source_path,
        override_alias=excluded.override_alias,
        updated_at=excluded.updated_at
    `).run(session.id, projectKey(project.path), project.path, sourceType, provider, nativeId,
      sourcePath, overrideAlias, timestamp, timestamp);
  }

  #activeTask(sessionId) {
    return this.db.prepare(`
      SELECT * FROM tasks
      WHERE session_id=? AND status IN ('queued', 'running', 'waiting_approval')
      ORDER BY created_at, id LIMIT 1
    `).get(sessionId) || null;
  }

  #updateRecentContext(messageId, session, timestamp = now()) {
    const inbound = this.db.prepare("SELECT chat_id, sender_id FROM inbox WHERE message_id=?").get(messageId);
    if (!inbound || !session) return;
    this.db.prepare(`
      INSERT INTO recent_session_contexts(
        chat_id, sender_id, session_id, executor, project_alias, project_path, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id, sender_id) DO UPDATE SET
        session_id=excluded.session_id,
        executor=excluded.executor,
        project_alias=excluded.project_alias,
        project_path=excluded.project_path,
        updated_at=excluded.updated_at
    `).run(inbound.chat_id, inbound.sender_id, session.id, session.executor,
      session.project_alias, session.project_path, timestamp);
  }

  recentSessionContext({ chatId, senderId, ttlMs = 30 * 60 * 1000, timestamp = now() }) {
    if (!chatId || !senderId) return null;
    const row = this.db.prepare(`
      SELECT c.*, s.name, s.native_id, s.status
      FROM recent_session_contexts c JOIN sessions s ON s.id=c.session_id
      WHERE c.chat_id=? AND c.sender_id=? AND c.updated_at>? AND s.status <> 'archived'
    `).get(chatId, senderId, timestamp - ttlMs);
    return row || null;
  }

  #resolveTaskSession(candidate, requested) {
    if (candidate?.gatewayId) {
      const session = this.getSession(candidate.gatewayId);
      if (!session || session.status === "archived") return { ok: false, reason: "stale_target" };
      this.#recordProjectAuthority(session, requested.project, candidate?.authority || requested.project?.authorities?.[0]);
      return { ok: true, session };
    }
    if (candidate?.nativeId) {
      const nativeId = String(candidate.nativeId).toLowerCase();
      const conflict = this.db.prepare(`
        SELECT 1 FROM native_session_claim_conflicts WHERE executor=? AND native_id=? AND resolved_at IS NULL
      `).get(candidate.executor, nativeId);
      if (conflict) return { ok: false, reason: "identity_conflict" };
      const claim = this.db.prepare("SELECT session_id FROM native_session_claims WHERE executor=? AND native_id=?")
        .get(candidate.executor, nativeId);
      if (claim) {
        const session = this.getSession(claim.session_id);
        if (!session || session.status === "archived") return { ok: false, reason: "stale_target" };
        this.#recordProjectAuthority(session, requested.project, candidate?.authority || requested.project?.authorities?.[0]);
        return { ok: true, session };
      }
    }
    const id = shortId(requested.executor === "codex" ? "CX" : "CL");
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO sessions(id, executor, project_alias, project_path, native_id, name, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)
    `).run(id, requested.executor, requested.project.alias, requested.project.path,
      candidate?.nativeId || null, requested.name, timestamp, timestamp);
    const session = this.getSession(id);
    if (candidate?.nativeId) this.db.prepare("INSERT INTO native_session_claims VALUES (?, ?, ?, ?)")
      .run(requested.executor, String(candidate.nativeId).toLowerCase(), id, timestamp);
    this.#recordProjectAuthority(session, requested.project, candidate?.authority || requested.project?.authorities?.[0]);
    return { ok: true, session, created: true };
  }

  commitNamedTask(request) {
    return this.#commitTask(request);
  }

  commitNotificationTask(request) {
    const candidate = request.candidate;
    if (!candidate || candidate.executor !== request.executor
      || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(candidate.nativeId || "")
      || request.action !== "continue") return { ok: false, reason: "stale_target" };
    return this.#commitTask(request, true);
  }

  #commitTask({
    messageId, candidate = null, executor, project, name, content, action = "continue", approvalProfile = null,
  }, nativeReply = false) {
    if (this.taskBlockedByOffWork(messageId)) return { ok: false, reason: 'off_work' };
    return this.#transaction(() => {
      const existingTask = this.db.prepare("SELECT * FROM tasks WHERE message_id=?").get(messageId);
      if (existingTask) {
        this.bindMessage(messageId, existingTask.session_id, "inbound");
        return { ok: true, session: this.getSession(existingTask.session_id), task: existingTask, repeated: true };
      }
      const taskCandidate = candidate?.kind === "existing-session" ? candidate.candidate : candidate;
      if (nativeReply) {
        const nativeConflict = this.db.prepare(`SELECT 1 FROM native_session_claim_conflicts
          WHERE executor=? AND native_id=? AND resolved_at IS NULL`).get(executor, taskCandidate.nativeId);
        const mapped = this.db.prepare("SELECT id FROM sessions WHERE executor=? AND lower(native_id)=?")
          .all(executor, taskCandidate.nativeId);
        if (nativeConflict || mapped.length > 1) return { ok: false, reason: "identity_conflict" };
        if (taskCandidate.gatewayId && mapped[0]?.id !== taskCandidate.gatewayId) return { ok: false, reason: "stale_target" };
      }
      const resolved = this.#resolveTaskSession(taskCandidate, { executor, project, name });
      if (!resolved.ok) return resolved;
      const nameClaim = this.#claimName(resolved.session);
      if (!nameClaim.ok && nativeReply && ["name_in_use", "name_claim_conflict"].includes(nameClaim.reason)) {
        const key = normalizeExactSessionName(resolved.session.name).key;
        const existing = this.db.prepare(`SELECT session_ids_json FROM session_exact_name_claim_conflicts
          WHERE executor=? AND exact_name=?`).get(executor, key);
        const ids = [...new Set([...parseJson(existing?.session_ids_json, []), nameClaim.sessionId, resolved.session.id].filter(Boolean))].sort();
        this.db.prepare(`INSERT INTO session_exact_name_claim_conflicts VALUES (?, ?, ?, NULL, ?)
          ON CONFLICT(executor, exact_name) DO UPDATE SET session_ids_json=excluded.session_ids_json, resolved_at=NULL`)
          .run(executor, key, JSON.stringify(ids), now());
        nameClaim.ok = true;
      }
      if (!nameClaim.ok) {
        if (resolved.created) {
          this.db.prepare("DELETE FROM native_session_claims WHERE session_id=?").run(resolved.session.id);
          this.db.prepare("DELETE FROM sessions WHERE id=?").run(resolved.session.id);
        }
        return nameClaim;
      }
      const active = this.#activeTask(resolved.session.id);
      if (active) return { ok: false, reason: "busy", taskId: active.id };
      const id = shortId("TK");
      const timestamp = now();
      this.db.prepare(`
        INSERT INTO tasks(id, session_id, message_id, action, content, approval_profile_json, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)
      `).run(id, resolved.session.id, messageId, action, content, serializeApprovalProfile(approvalProfile), timestamp, timestamp);
      this.db.prepare("UPDATE sessions SET status='queued', updated_at=? WHERE id=?")
        .run(timestamp, resolved.session.id);
      this.bindMessage(messageId, resolved.session.id, "inbound");
      this.db.prepare(`
        UPDATE session_lookup_requests SET state='committed', decision=?, session_id=?, task_id=?, updated_at=?
        WHERE message_id=?
      `).run(resolved.created ? "created" : "continued", resolved.session.id, id, timestamp, messageId);
      const session = this.getSession(resolved.session.id);
      this.#updateRecentContext(messageId, session, timestamp);
      return { ok: true, session, task: this.getTask(id), created: Boolean(resolved.created) };
    });
  }

  commitCandidateTask({ candidateSetId, candidatePageId = null, selectionMessageId, selectedIndex, candidate, executor, project, name, content, action = "continue" }) {
    if (this.taskBlockedByOffWork(selectionMessageId)) return { ok: false, reason: 'off_work' };
    return this.#transaction(() => {
      const set = this.db.prepare("SELECT * FROM session_candidate_sets WHERE id=?").get(candidateSetId);
      if (!set) return { ok: false, reason: "selection_expired" };
      if (set.state === "consumed") {
        const prior = this.db.prepare("SELECT * FROM tasks WHERE message_id=?").get(set.selection_message_id);
        return { ok: true, repeated: true, session: prior ? this.getSession(prior.session_id) : null, task: prior || null };
      }
      if (set.state !== "open" || Number(set.expires_at) <= now()) {
        this.db.prepare("UPDATE session_candidate_sets SET state='expired' WHERE id=? AND state='open'").run(candidateSetId);
        return { ok: false, reason: "selection_expired" };
      }
      const pageId = candidatePageId || set.active_page_id;
      const page = pageId ? this.db.prepare(`
        SELECT * FROM session_candidate_pages WHERE id=? AND candidate_set_id=?
      `).get(pageId, candidateSetId) : null;
      const candidates = parseJson(page?.candidates_json || set.candidates_json, []);
      if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= candidates.length
        || candidates[selectedIndex]?.identity !== candidate?.identity) return { ok: false, reason: "stale_target" };
      const taskCandidate = candidate?.kind === "existing-session" ? candidate.candidate : candidate;
      const resolved = this.#resolveTaskSession(taskCandidate, { executor, project, name });
      if (!resolved.ok) return resolved;
      const nameClaim = this.#claimName(resolved.session);
      if (!nameClaim.ok) {
        if (resolved.created) {
          this.db.prepare("DELETE FROM native_session_claims WHERE session_id=?").run(resolved.session.id);
          this.db.prepare("DELETE FROM sessions WHERE id=?").run(resolved.session.id);
        }
        return nameClaim;
      }
      const active = this.#activeTask(resolved.session.id);
      if (active) return { ok: false, reason: "busy", taskId: active.id };
      const taskId = shortId("TK");
      const timestamp = now();
      const lookup = this.getSessionLookup(set.request_message_id);
      this.db.prepare(`INSERT INTO tasks(
        id, session_id, message_id, action, content, approval_profile_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`)
        .run(taskId, resolved.session.id, selectionMessageId, action, content,
          lookup?.approval_profile_json || null, timestamp, timestamp);
      this.bindMessage(set.request_message_id, resolved.session.id, "inbound");
      this.bindMessage(selectionMessageId, resolved.session.id, "inbound");
      const consumed = this.db.prepare(`
        UPDATE session_candidate_sets SET state='consumed', selected_index=?, selection_message_id=?, consumed_at=?
        WHERE id=? AND state='open' AND expires_at>?
      `).run(selectedIndex, selectionMessageId, timestamp, candidateSetId, timestamp);
      if (Number(consumed.changes) !== 1) throw new Error("Candidate set consumption race");
      this.db.prepare(`
        UPDATE session_lookup_requests SET state='committed', decision='continued', session_id=?, task_id=?, updated_at=?
        WHERE message_id=?
      `).run(resolved.session.id, taskId, timestamp, set.request_message_id);
      this.db.prepare("UPDATE sessions SET status='queued', updated_at=? WHERE id=?")
        .run(timestamp, resolved.session.id);
      this.db.prepare("UPDATE inbox SET status='processed' WHERE message_id IN (?, ?)")
        .run(set.request_message_id, selectionMessageId);
      const session = this.getSession(resolved.session.id);
      this.#updateRecentContext(set.request_message_id, session, timestamp);
      return { ok: true, session, task: this.getTask(taskId), created: Boolean(resolved.created) };
    });
  }

  listQueuedTasks() {
    return this.db.prepare(`
      SELECT t.* FROM tasks t JOIN sessions s ON s.id=t.session_id
      WHERE t.status='queued' AND s.status <> 'archived' ORDER BY t.created_at, t.id
    `).all().map((task) => ({ task, session: this.getSession(task.session_id) }));
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

  getProjectAuthority(sessionId) {
    return this.db.prepare("SELECT * FROM project_authorities WHERE session_id=?").get(sessionId) || null;
  }

  setProjectAuthority(sessionId, project, authority) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    this.#transaction(() => this.#recordProjectAuthority(session, project, authority));
    return this.getProjectAuthority(sessionId);
  }

  listSessions(limit = 20) {
    return this.db.prepare("SELECT * FROM sessions WHERE status <> 'archived' ORDER BY updated_at DESC LIMIT ?").all(limit);
  }

  listSessionsBounded(limit = 20000) {
    const rows = this.db.prepare(`
      SELECT * FROM sessions WHERE status <> 'archived'
      ORDER BY updated_at DESC, id ASC LIMIT ?
    `).all(limit + 1);
    return { records: rows.slice(0, limit), complete: rows.length <= limit };
  }

  findSessions({ executor = null, projectAlias = null, reference = null } = {}) {
    if (reference != null) {
      const needle = String(reference).trim();
      if (!needle) return [];
      const clauses = ["status <> 'archived'", "(id = ? COLLATE NOCASE OR name = ? COLLATE NOCASE)"];
      const params = [needle, needle];
      if (executor) { clauses.push("executor = ?"); params.push(executor); }
      if (projectAlias) { clauses.push("project_alias = ? COLLATE NOCASE"); params.push(projectAlias.trim()); }
      return this.db.prepare(`
        SELECT * FROM sessions WHERE ${clauses.join(" AND ")}
        ORDER BY updated_at DESC, id ASC
      `).all(...params);
    }
    let rows = this.listSessions(100);
    if (executor) rows = rows.filter((row) => row.executor === executor);
    if (projectAlias) rows = rows.filter((row) => row.project_alias.toLowerCase() === projectAlias.toLowerCase());
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

  createTask({ sessionId, messageId, action, content, approvalProfile = null }) {
    if (this.taskBlockedByOffWork(messageId)) throw new Error('该请求被下班操作取消，请重新发送任务。');
    const id = shortId("TK");
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO tasks(id, session_id, message_id, action, content, approval_profile_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)
    `).run(id, sessionId, messageId || null, action, content, serializeApprovalProfile(approvalProfile), timestamp, timestamp);
    return this.getTask(id);
  }

  getTask(id) {
    return this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) || null;
  }

  enrichActivitySnapshot(snapshot, maximum = 201) {
    if (!Array.isArray(snapshot) || snapshot.length > maximum) throw new Error("Scheduler activity snapshot is invalid");
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

  taskForMessage(messageId) {
    return this.db.prepare("SELECT * FROM tasks WHERE message_id=?").get(messageId) || null;
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

  createApproval({
    sessionId, taskId, description, operationClass = null, grantEligible = false, ttlMs = 600000,
  }) {
    const id = shortId("RQ");
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO approvals(
        id, session_id, task_id, description, operation_class, grant_eligible, status, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(id, sessionId, taskId, description, operationClass, grantEligible ? 1 : 0, timestamp, timestamp + ttlMs);
    return this.getApproval(id);
  }

  getApproval(id) {
    return this.db.prepare("SELECT * FROM approvals WHERE id=?").get(id) || null;
  }

  listPendingApprovals() {
    return this.db.prepare("SELECT * FROM approvals WHERE status='pending' AND expires_at>? ORDER BY created_at DESC").all(now());
  }

  approvalForMessage(messageId) {
    if (!messageId) return null;
    return this.db.prepare(`
      SELECT a.* FROM approval_prompt_bindings b
      JOIN approvals a ON a.id=b.approval_id
      JOIN tasks t ON t.id=b.task_id
      WHERE b.message_id=? AND a.status='pending' AND a.expires_at>?
        AND t.status IN ('running', 'waiting_approval')
    `).get(messageId, now()) || null;
  }

  resolveApproval(id, status) {
    const result = this.db.prepare("UPDATE approvals SET status=? WHERE id=? AND status='pending'").run(status, id);
    return Number(result.changes) === 1;
  }

  expireApprovals() {
    this.db.prepare("UPDATE approvals SET status='expired' WHERE status='pending' AND expires_at<=?").run(now());
  }

  enqueueOutbox(dedupeKey, text, sessionId = null, {
    candidateSetId = null, candidatePageId = null, approvalId = null,
  } = {}) {
    this.db.prepare(`
      INSERT OR IGNORE INTO outbox(
        dedupe_key, text, session_id, candidate_set_id, candidate_page_id, approval_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(dedupeKey, text, sessionId, candidateSetId, candidatePageId, approvalId, now());
  }

  hasOutboxBatch(key) {
    return Boolean(this.db.prepare("SELECT id FROM outbox WHERE dedupe_key=?").get(`${key}-page-1`));
  }

  enqueueOutboxBatch(key, pages) {
    if (!pages.length) throw new Error("Outbox batch must contain at least one page");
    return this.#transaction(() => {
      // Keep the first snapshot intact when the same inbound message is retried.
      if (this.hasOutboxBatch(key)) return false;
      for (const [index, text] of pages.entries()) this.enqueueOutbox(`${key}-page-${index + 1}`, text);
      return true;
    });
  }

  nextOutbox(timestamp = now()) {
    while (true) {
      const row = this.db.prepare("SELECT * FROM outbox WHERE status='pending' ORDER BY id LIMIT 1").get() || null;
      if (!row || !row.candidate_set_id) return row;
      const set = this.db.prepare("SELECT state, expires_at FROM session_candidate_sets WHERE id=?").get(row.candidate_set_id);
      if (set?.state === "open" && Number(set.expires_at) > timestamp) return row;
      this.#transaction(() => {
        this.db.prepare("UPDATE outbox SET status='expired', attempts=attempts+1 WHERE id=? AND status='pending'").run(row.id);
        if (set?.state === "open") {
          this.db.prepare("UPDATE session_candidate_sets SET state='expired' WHERE id=? AND state='open'")
            .run(row.candidate_set_id);
          this.db.prepare(`
            INSERT OR IGNORE INTO outbox(dedupe_key, text, created_at)
            VALUES (?, ?, ?)
          `).run(`candidate-expired-${row.candidate_set_id}`,
            "[Gateway | - | - | -]\n候选列表已过期，请重新发送原命令。", timestamp);
        }
      });
    }
  }

  markOutboxSent(id, remoteMessageId = null) {
    return this.completeOutboxDelivery(id, remoteMessageId);
  }

  completeOutboxDelivery(id, remoteMessageId = null, timestamp = now()) {
    return this.#transaction(() => {
      const row = this.db.prepare("SELECT * FROM outbox WHERE id=?").get(id);
      if (!row) return false;
      if (row.status === "sent") return true;
      if (row.status !== "pending") return false;
      this.db.prepare(`
        UPDATE outbox SET status='sent', remote_message_id=?, attempts=attempts+1, sent_at=?
        WHERE id=? AND status='pending'
      `).run(remoteMessageId, timestamp, id);
      if (remoteMessageId && row.session_id) this.bindMessage(remoteMessageId, row.session_id, "outbound");
      if (remoteMessageId && row.approval_id) {
        const approval = this.getApproval(row.approval_id);
        if (approval) this.db.prepare(`
          INSERT OR REPLACE INTO approval_prompt_bindings(
            message_id, approval_id, task_id, session_id, created_at
          ) VALUES (?, ?, ?, ?, ?)
        `).run(remoteMessageId, approval.id, approval.task_id, approval.session_id, timestamp);
      }
      if (remoteMessageId && row.candidate_set_id) {
        const set = this.db.prepare("SELECT * FROM session_candidate_sets WHERE id=?").get(row.candidate_set_id);
        const pageId = row.candidate_page_id || set?.active_page_id || null;
        if (pageId) {
          this.db.prepare(`
            INSERT OR REPLACE INTO session_candidate_message_bindings(
              message_id, candidate_set_id, candidate_page_id, created_at
            ) VALUES (?, ?, ?, ?)
          `).run(remoteMessageId, row.candidate_set_id, pageId, timestamp);
          this.db.prepare("UPDATE session_candidate_pages SET sent_at=COALESCE(sent_at, ?) WHERE id=?")
            .run(timestamp, pageId);
          this.db.prepare(`
            UPDATE session_candidate_sets SET expires_at=?
            WHERE id=? AND state='open'
          `).run(timestamp + 30 * 60 * 1000, row.candidate_set_id);
        }
      }
      return true;
    });
  }

  markOutboxFailed(id) {
    this.db.prepare("UPDATE outbox SET attempts=attempts+1 WHERE id=?").run(id);
  }

  createStopTarget(target, ttlMs = 600000) {
    const normalized = normalizeStopTarget(target);
    const stopRef = opaqueId("ST");
    const timestamp = now();
    const key = targetKey(normalized);
    this.db.prepare(`
      INSERT INTO agent_stop_targets(
        stop_ref, provider, agent, session_id, provider_target_key, target_json, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(stopRef, normalized.provider, normalized.agent, normalized.sessionId, key,
      JSON.stringify(normalized), timestamp, timestamp + ttlMs);
    this.cleanupStopState(timestamp);
    return { stopRef, target: normalized, providerTargetKey: key, expiresAt: timestamp + ttlMs };
  }

  getStopTarget(stopRef) {
    const row = this.db.prepare("SELECT * FROM agent_stop_targets WHERE stop_ref=?").get(stopRef);
    if (!row) return null;
    return { ...row, target: parseJson(row.target_json) };
  }

  getStopOperation(operationId) {
    const row = this.db.prepare("SELECT * FROM agent_stop_operations WHERE id=?").get(operationId);
    return row ? { ...row, target: parseJson(row.target_json) } : null;
  }

  claimStopOperation({ stopRef, messageId, ownerEpoch, ownerToken }) {
    if (!/^ST-[0-9A-F]{32}$/.test(stopRef || "") || !messageId || !ownerEpoch || !ownerToken) {
      return { status: "invalid_session_ref" };
    }
    return this.#transaction(() => {
      const existingRequest = this.db.prepare(`
        SELECT operation_id FROM agent_stop_requests WHERE message_id=?
      `).get(messageId);
      if (existingRequest) {
        let operation = this.getStopOperation(existingRequest.operation_id);
        if (!operation) return { status: "invalid_session_ref" };
        const terminal = operation.state === "completed" || operation.state === "uncertain";
        let ownsExecution = operation.owner_epoch === ownerEpoch && operation.owner_token === ownerToken;
        if (!terminal && operation.state === "pending" && !operation.owner_epoch && !operation.owner_token) {
          const acquired = this.db.prepare(`
            UPDATE agent_stop_operations SET owner_epoch=?, owner_token=?, updated_at=?
            WHERE id=? AND state='pending' AND owner_epoch IS NULL AND owner_token IS NULL
          `).run(ownerEpoch, ownerToken, now(), operation.id);
          ownsExecution = Number(acquired.changes) === 1;
          operation = this.getStopOperation(operation.id);
        }
        return {
          status: terminal ? "terminal" : ownsExecution ? "claimed" : "waiting",
          operation,
          target: operation.target,
          ownsExecution,
        };
      }

      const claimed = this.db.prepare("SELECT operation_id FROM agent_stop_ref_claims WHERE stop_ref=?").get(stopRef);
      let operation = claimed ? this.getStopOperation(claimed.operation_id) : null;
      let target = null;
      if (!operation) {
        const row = this.db.prepare("SELECT * FROM agent_stop_targets WHERE stop_ref=?").get(stopRef);
        if (!row) return { status: "invalid_session_ref" };
        if (Number(row.expires_at) <= now()) return { status: "expired_session_ref" };
        target = parseJson(row.target_json);
        if (!target) return { status: "invalid_session_ref" };
        operation = this.db.prepare("SELECT * FROM agent_stop_operations WHERE active_operation_key=?").get(row.provider_target_key);
        if (!operation) {
          const operationId = opaqueId("SO");
          const timestamp = now();
          this.db.prepare(`
            INSERT INTO agent_stop_operations(
              id, provider_target_key, active_operation_key, provider, agent, session_id,
              target_json, state, owner_epoch, owner_token, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
          `).run(operationId, row.provider_target_key, row.provider_target_key, row.provider, row.agent,
            row.session_id, row.target_json, ownerEpoch, ownerToken, timestamp, timestamp);
          operation = this.db.prepare("SELECT * FROM agent_stop_operations WHERE id=?").get(operationId);
        }
        this.db.prepare(`
          INSERT INTO agent_stop_ref_claims(stop_ref, operation_id, created_at) VALUES (?, ?, ?)
        `).run(stopRef, operation.id, now());
      }

      const outboxKey = `internal-stop-${messageId}`;
      this.db.prepare(`
        INSERT INTO agent_stop_requests(message_id, operation_id, stop_ref, outbox_dedupe_key, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(messageId, operation.id, stopRef, outboxKey, now());

      operation = this.db.prepare("SELECT * FROM agent_stop_operations WHERE id=?").get(operation.id);
      const terminal = operation.state === "completed" || operation.state === "uncertain";
      if (terminal && operation.reply_text) {
        this.db.prepare(`
          INSERT OR IGNORE INTO outbox(dedupe_key, text, session_id, created_at) VALUES (?, ?, NULL, ?)
        `).run(outboxKey, operation.reply_text.replaceAll("{STOP_REF}", stopRef), now());
      }
      let ownsExecution = operation.owner_epoch === ownerEpoch && operation.owner_token === ownerToken;
      if (!terminal && operation.state === "pending" && !operation.owner_epoch && !operation.owner_token) {
        const acquired = this.db.prepare(`
          UPDATE agent_stop_operations SET owner_epoch=?, owner_token=?, updated_at=?
          WHERE id=? AND state='pending' AND owner_epoch IS NULL AND owner_token IS NULL
        `).run(ownerEpoch, ownerToken, now(), operation.id);
        ownsExecution = Number(acquired.changes) === 1;
        operation = this.db.prepare("SELECT * FROM agent_stop_operations WHERE id=?").get(operation.id);
      }
      return {
        status: terminal ? "terminal" : ownsExecution ? "claimed" : "waiting",
        operation: { ...operation, target: parseJson(operation.target_json) },
        target: target || parseJson(operation.target_json),
        ownsExecution,
      };
    });
  }

  markStopSignaling(operationId, ownerEpoch, ownerToken) {
    const result = this.db.prepare(`
      UPDATE agent_stop_operations
      SET state='signaling', ever_signaled=1, updated_at=?
      WHERE id=? AND state='pending' AND owner_epoch=? AND owner_token=?
    `).run(now(), operationId, ownerEpoch, ownerToken);
    return Number(result.changes) === 1;
  }

  releaseStopAttempt(operationId, ownerEpoch, ownerToken) {
    const result = this.db.prepare(`
      UPDATE agent_stop_operations
      SET owner_epoch=NULL, owner_token=NULL, attempts=attempts+1, updated_at=?
      WHERE id=? AND state='pending' AND owner_epoch=? AND owner_token=?
    `).run(now(), operationId, ownerEpoch, ownerToken);
    return Number(result.changes) === 1;
  }

  failStopAttempt({ operationId, ownerEpoch, ownerToken, outcome, replyText, maxAttempts = 2 }) {
    if (!outcome || !replyText || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error("Stop attempt failure is invalid");
    }
    return this.#transaction(() => {
      const operation = this.db.prepare("SELECT * FROM agent_stop_operations WHERE id=?").get(operationId);
      if (!operation || operation.state !== "pending"
        || operation.owner_epoch !== ownerEpoch || operation.owner_token !== ownerToken) {
        return { status: "lost" };
      }
      const attempts = Number(operation.attempts) + 1;
      if (attempts < maxAttempts) {
        this.db.prepare(`
          UPDATE agent_stop_operations
          SET owner_epoch=NULL, owner_token=NULL, attempts=?, updated_at=?
          WHERE id=? AND state='pending' AND owner_epoch=? AND owner_token=?
        `).run(attempts, now(), operationId, ownerEpoch, ownerToken);
        return { status: "released", attempts };
      }

      const timestamp = now();
      this.db.prepare(`
        UPDATE agent_stop_operations
        SET state='completed', outcome=?, reply_text=?, active_operation_key=NULL,
          owner_epoch=NULL, owner_token=NULL, attempts=?, updated_at=?, completed_at=?
        WHERE id=? AND state='pending' AND owner_epoch=? AND owner_token=?
      `).run(outcome, replyText, attempts, timestamp, timestamp,
        operationId, ownerEpoch, ownerToken);
      const requests = this.db.prepare(`
        SELECT stop_ref, outbox_dedupe_key FROM agent_stop_requests WHERE operation_id=?
      `).all(operationId);
      const enqueue = this.db.prepare(`
        INSERT OR IGNORE INTO outbox(dedupe_key, text, session_id, created_at) VALUES (?, ?, NULL, ?)
      `);
      for (const request of requests) enqueue.run(
        request.outbox_dedupe_key,
        replyText.replaceAll("{STOP_REF}", request.stop_ref),
        timestamp,
      );
      return { status: "terminal", attempts };
    });
  }

  terminalizeStopOperation({ operationId, ownerEpoch, ownerToken, state = "completed", outcome, replyText, releaseActiveKey = false }) {
    if (!["completed", "uncertain"].includes(state) || !outcome || !replyText) throw new Error("Stop terminal result is invalid");
    return this.#transaction(() => {
      const operation = this.db.prepare("SELECT * FROM agent_stop_operations WHERE id=?").get(operationId);
      if (!operation || operation.owner_epoch !== ownerEpoch || operation.owner_token !== ownerToken
        || !["pending", "signaling"].includes(operation.state)) return false;
      const mayRelease = releaseActiveKey && Number(operation.ever_signaled) === 0;
      const timestamp = now();
      this.db.prepare(`
        UPDATE agent_stop_operations SET state=?, outcome=?, reply_text=?,
          active_operation_key=CASE WHEN ? THEN NULL ELSE active_operation_key END,
          owner_epoch=NULL, owner_token=NULL, updated_at=?, completed_at=?
        WHERE id=? AND state=? AND owner_epoch=? AND owner_token=?
      `).run(state, outcome, replyText, mayRelease ? 1 : 0, timestamp, timestamp,
        operationId, operation.state, ownerEpoch, ownerToken);
      const requests = this.db.prepare(`
        SELECT stop_ref, outbox_dedupe_key FROM agent_stop_requests WHERE operation_id=?
      `).all(operationId);
      const enqueue = this.db.prepare(`
        INSERT OR IGNORE INTO outbox(dedupe_key, text, session_id, created_at) VALUES (?, ?, NULL, ?)
      `);
      for (const request of requests) enqueue.run(request.outbox_dedupe_key, replyText.replaceAll("{STOP_REF}", request.stop_ref), timestamp);
      return true;
    });
  }

  enqueueStopRequestReply(messageId, text) {
    const request = this.db.prepare(`
      SELECT outbox_dedupe_key FROM agent_stop_requests WHERE message_id=?
    `).get(messageId);
    if (!request) return false;
    this.db.prepare(`
      INSERT OR IGNORE INTO outbox(dedupe_key, text, session_id, created_at) VALUES (?, ?, NULL, ?)
    `).run(request.outbox_dedupe_key, text, now());
    return true;
  }

  getTasksByIds(taskIds) {
    const ids = [...new Set((taskIds || []).map(String).filter(Boolean))];
    if (!ids.length || ids.length > 200) return [];
    const select = this.db.prepare("SELECT * FROM tasks WHERE id=?");
    return ids.map((id) => select.get(id)).filter(Boolean);
  }

  listRecoverableStopOperations() {
    return this.db.prepare(`
      SELECT * FROM agent_stop_operations WHERE state IN ('pending', 'signaling') ORDER BY created_at
    `).all().map((row) => ({ ...row, target: parseJson(row.target_json) }));
  }

  listStopRequestsMissingOutbox() {
    return this.db.prepare(`
      SELECT r.*, o.state, o.outcome, o.reply_text
      FROM agent_stop_requests r
      JOIN agent_stop_operations o ON o.id=r.operation_id
      LEFT JOIN outbox b ON b.dedupe_key=r.outbox_dedupe_key
      WHERE b.id IS NULL
      ORDER BY r.created_at
    `).all();
  }

  repairStopRequestOutbox(request) {
    if (!request?.outbox_dedupe_key || !request?.reply_text || !request?.stop_ref) return false;
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO outbox(dedupe_key, text, session_id, created_at) VALUES (?, ?, NULL, ?)
    `).run(request.outbox_dedupe_key, request.reply_text.replaceAll("{STOP_REF}", request.stop_ref), now());
    return Number(result.changes) === 1;
  }

  releaseOwnedPendingStops(epoch) {
    const result = this.db.prepare(`
      UPDATE agent_stop_operations
      SET owner_epoch=NULL, owner_token=NULL, updated_at=?
      WHERE state='pending' AND owner_epoch=?
    `).run(now(), epoch);
    return Number(result.changes);
  }

  getGatewayInstanceOwner() {
    return this.db.prepare("SELECT * FROM gateway_instance_owner WHERE singleton_id=1").get() || null;
  }

  claimGatewayInstance({ pid, procStart, epoch, expectedOwner = null }) {
    if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0 || !/^\d{10,20}$/.test(String(procStart || "")) || !epoch) {
      throw new Error("Gateway instance identity is invalid");
    }
    return this.#transaction(() => {
      const current = this.getGatewayInstanceOwner();
      const expected = expectedOwner && {
        pid: Number(expectedOwner.pid), proc_start: String(expectedOwner.proc_start), epoch: String(expectedOwner.epoch), state: String(expectedOwner.state),
      };
      const matches = current === null ? expectedOwner === null
        : expected && Number(current.pid) === expected.pid && current.proc_start === expected.proc_start
          && current.epoch === expected.epoch && current.state === expected.state;
      if (!matches) throw new Error("Gateway instance owner changed");
      this.db.prepare(`
        INSERT INTO gateway_instance_owner(singleton_id, pid, proc_start, epoch, state, updated_at)
        VALUES (1, ?, ?, ?, 'running', ?)
        ON CONFLICT(singleton_id) DO UPDATE SET
          pid=excluded.pid, proc_start=excluded.proc_start, epoch=excluded.epoch,
          state='running', updated_at=excluded.updated_at
      `).run(Number(pid), String(procStart), String(epoch), now());
      const stranded = this.db.prepare(`
        SELECT id FROM agent_stop_operations WHERE state IN ('pending', 'signaling')
      `).all();
      const claimed = [];
      for (const row of stranded) {
        const token = randomBytes(16).toString("hex");
        this.db.prepare(`
          UPDATE agent_stop_operations SET owner_epoch=?, owner_token=?, updated_at=? WHERE id=?
        `).run(String(epoch), token, now(), row.id);
        claimed.push({ operationId: row.id, ownerToken: token });
      }
      return claimed;
    });
  }

  markGatewayInstanceDraining(epoch) {
    const result = this.db.prepare(`
      UPDATE gateway_instance_owner SET state='draining', updated_at=?
      WHERE singleton_id=1 AND epoch=?
    `).run(now(), epoch);
    return Number(result.changes) === 1;
  }

  cleanupStopState(timestamp = now()) {
    this.#transaction(() => {
      this.db.prepare("DELETE FROM agent_stop_targets WHERE expires_at<=?").run(timestamp);
      const excessTargets = this.db.prepare(`
        SELECT stop_ref FROM agent_stop_targets ORDER BY created_at DESC LIMIT -1 OFFSET 500
      `).all();
      const deleteTarget = this.db.prepare("DELETE FROM agent_stop_targets WHERE stop_ref=?");
      for (const row of excessTargets) deleteTarget.run(row.stop_ref);

      this.db.prepare(`
        DELETE FROM agent_stop_operations
        WHERE state IN ('completed', 'uncertain') AND completed_at<?
      `).run(timestamp - 30 * 24 * 60 * 60 * 1000);
      const excessOperations = this.db.prepare(`
        SELECT id FROM agent_stop_operations
        WHERE state IN ('completed', 'uncertain')
        ORDER BY completed_at DESC LIMIT -1 OFFSET 5000
      `).all();
      const deleteOperation = this.db.prepare("DELETE FROM agent_stop_operations WHERE id=?");
      for (const row of excessOperations) deleteOperation.run(row.id);
    });
  }

  close() {
    this.db.close();
  }
}
