import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

const REQUIRED_TURN_COLUMNS = ["thread_id", "turn_id", "rollout_ordinal", "status", "started_at"];
const REQUIRED_THREAD_COLUMNS = ["id", "name", "cwd", "updated_at_ms"];

function validateColumns(db, table, required) {
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  const missing = required.filter((column) => !columns.has(column));
  if (missing.length) throw new Error(`${table} missing columns: ${missing.join(", ")}`);
}

function openReadOnly(filePath) {
  const db = new DatabaseSync(filePath, { readOnly: true });
  db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=250;");
  return db;
}

function collect() {
  const history = openReadOnly(workerData.historyPath);
  const state = openReadOnly(workerData.statePath);
  try {
    validateColumns(history, "thread_turns", REQUIRED_TURN_COLUMNS);
    validateColumns(state, "threads", REQUIRED_THREAD_COLUMNS);
    if (workerData.mode === "catalog") {
      validateColumns(state, "threads", ["thread_source", "source", "archived"]);
      const latestTurn = history.prepare(`
        SELECT thread_id, turn_id, status, started_at, rollout_ordinal
        FROM thread_turns
        WHERE thread_id=?
        ORDER BY rollout_ordinal DESC, COALESCE(started_at, 0) DESC, turn_id ASC
        LIMIT 1
      `);
      // The name index also contains internal guardian/subagent threads and can
      // omit unnamed user threads. Native state defines the complete user set.
      const index = new Map((workerData.indexEntries || []).map(entry => [entry.id, entry]));
      const rows = state.prepare(`SELECT id, name, cwd, updated_at_ms, thread_source, source, archived FROM threads
        WHERE thread_source='user' OR (thread_source IS NULL AND source IN ('cli', 'vscode', 'exec', 'appServer', 'app-server', 'unknown'))
        ORDER BY updated_at_ms DESC, id LIMIT 20001`).all();
      const records = [];
      for (const meta of rows.slice(0, 20000)) {
        const entry = index.get(meta.id) || {};
        const turn = latestTurn.get(meta.id) || null;
        records.push({
          provider: "codex",
          executor: "codex",
          nativeId: meta.id,
          sessionId: meta.id,
          threadSource: meta.thread_source,
          source: meta.source,
          archived: Boolean(meta.archived),
          name: entry.name || meta.name || null,
          aliases: meta.name && meta.name !== entry.name ? [meta.name] : [],
          cwd: typeof meta.cwd === "string" && meta.cwd.startsWith("\\\\?\\") ? meta.cwd.slice(4) : meta.cwd || null,
          updatedAt: Math.max(Number(entry.updatedAt || 0), Number(meta.updated_at_ms || 0), Number(turn?.started_at || 0) * 1000) || null,
          latestTurn: turn ? {
            turnId: turn.turn_id,
            status: turn.status,
            startedAt: turn.started_at,
            rolloutOrdinal: turn.rollout_ordinal,
          } : null,
        });
      }
      return { records, truncated: rows.length > 20000 };
    }
    if (workerData.threadId) {
      const row = history.prepare(`
        SELECT thread_id, turn_id, status, started_at, rollout_ordinal
        FROM thread_turns
        WHERE thread_id=?
        ORDER BY rollout_ordinal DESC, COALESCE(started_at, 0) DESC, turn_id ASC
        LIMIT 1
      `).get(workerData.threadId);
      return { exact: row ? {
        threadId: row.thread_id,
        turnId: row.turn_id,
        status: row.status,
        startedAt: row.started_at,
        rolloutOrdinal: row.rollout_ordinal,
      } : null };
    }
    const candidates = history.prepare(`
      WITH ranked AS (
        SELECT thread_id, turn_id, status, started_at, rollout_ordinal,
          ROW_NUMBER() OVER (
            PARTITION BY thread_id
            ORDER BY rollout_ordinal DESC, COALESCE(started_at, 0) DESC, turn_id ASC
          ) AS row_number
        FROM thread_turns
      )
      SELECT thread_id, turn_id, started_at, rollout_ordinal
      FROM ranked
      WHERE row_number=1 AND status='inProgress'
      ORDER BY COALESCE(started_at, 0) DESC, rollout_ordinal DESC, thread_id ASC
      LIMIT ?
    `).all(workerData.limit + 1);
    const metadata = state.prepare("SELECT name, cwd, updated_at_ms FROM threads WHERE id=?");
    const records = candidates.slice(0, workerData.limit).map((row) => {
      const meta = metadata.get(row.thread_id) || {};
      return {
        provider: "codex",
        agent: "codex",
        sessionId: row.thread_id,
        nativeId: row.thread_id,
        turnId: row.turn_id,
        name: meta.name || null,
        status: "running",
        cwd: typeof meta.cwd === "string" && meta.cwd.startsWith("\\\\?\\") ? meta.cwd.slice(4) : meta.cwd || null,
        pid: null,
        updatedAt: Number(meta.updated_at_ms || 0) || Number(row.started_at || 0) * 1000 || null,
        sourcePath: workerData.historyPath,
        lockPath: null,
      };
    });
    return { records, truncated: candidates.length > workerData.limit };
  } finally {
    history.close();
    state.close();
  }
}

try {
  parentPort.postMessage({ ok: true, ...collect() });
} catch (error) {
  parentPort.postMessage({ ok: false, error: String(error?.message || error).slice(0, 500) });
}
