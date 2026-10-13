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
