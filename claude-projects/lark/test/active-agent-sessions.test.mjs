import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import {
  aggregateActiveAgentRecords,
  collectActiveAgentSessionRecords,
  collectClaudeCandidates,
  collectCodexCandidates,
  collectCodexExact,
  formatActiveAgentSessions,
  listActiveAgentSessions,
  readExactClaudeSession,
  runWindowsSessionProbe,
} from "../src/active-agent-sessions.mjs";

function tempDirectory(prefix = "active-agent-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createCodexDatabases(root, generation = 1) {
  const historyPath = path.join(root, `thread_history_${generation}.sqlite`);
  const statePath = path.join(root, `state_${generation}.sqlite`);
  const history = new DatabaseSync(historyPath);
  history.exec(`CREATE TABLE thread_turns (
    thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, status TEXT,
    started_at INTEGER, PRIMARY KEY(thread_id, turn_id)
  )`);
  const state = new DatabaseSync(statePath);
  state.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY, name TEXT, cwd TEXT, updated_at_ms INTEGER
  )`);
  return { history, state, historyPath, statePath };
}

test("active records deduplicate by agent and native ID with gateway precedence", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const result = aggregateActiveAgentRecords([
    { provider: "codex", agent: "codex", sessionId: id, nativeId: id, name: "native", status: "running", cwd: "C:\\native", updatedAt: 20 },
    { provider: "gateway", agent: "codex", sessionId: "CX-1", gatewayId: "CX-1", nativeId: id, taskId: "TK-1", name: "managed", status: "waiting_approval", cwd: "C:\\project", updatedAt: 10 },
    { provider: "claude", agent: "claude", sessionId: id, nativeId: id, name: "claude", status: "running", cwd: "C:\\claude", pid: 42, updatedAt: 30 },
  ]);
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].agent, "codex");
  assert.equal(result.records[0].name, "managed");
  assert.equal(result.records[0].provider, "gateway+codex");
  assert.deepEqual(result.records[0].gatewayOwners, [{ gatewayId: "CX-1", taskIds: ["TK-1"] }]);
  assert.equal(result.records[1].agent, "claude");
});

test("active session formatter is bounded and reports hidden rows", () => {
  const records = Array.from({ length: 32 }, (_, index) => ({
    provider: "codex", agent: "codex", status: "running", name: `session-${index}`,
    sessionId: `id-${index}`, cwd: "C:\\work", updatedAt: 32 - index,
  }));
  const text = formatActiveAgentSessions(records, ["one warning"], { displayLimit: 30 });
  assert.match(text, /另有 2 个/);
  assert.match(text, /警告：one warning/);
  const stoppable = formatActiveAgentSessions([{ ...records[0], stopRef: "ST-0123456789ABCDEF0123456789ABCDEF" }]);
  assert.match(stoppable, /停止ID: ST-0123456789ABCDEF0123456789ABCDEF/);
  const unavailable = formatActiveAgentSessions([{ ...records[0], stopCapability: { ready: false, reason: "control_unreachable" } }]);
  assert.match(unavailable, /停止: 不可用 \(control_unreachable\)/);
});

test("Codex collector uses latest turns and the highest database generation", async () => {
  const root = tempDirectory();
  try {
    fs.mkdirSync(path.join(root, "thread-writer-locks"));
    const idActive = "11111111-1111-4111-8111-111111111111";
    const idDone = "22222222-2222-4222-8222-222222222222";
    const { history, state } = createCodexDatabases(root, 2);
    history.prepare("INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?)").run(idActive, "turn-a", 1, "inProgress", 100);
    history.prepare("INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?)").run(idDone, "turn-b1", 1, "inProgress", 200);
    history.prepare("INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?)").run(idDone, "turn-b2", 2, "completed", 300);
    state.prepare("INSERT INTO threads VALUES (?, ?, ?, ?)").run(idActive, "active", "C:\\work", 1234);
    history.close();
    state.close();
    const result = await collectCodexCandidates({ codexRoot: root });
    assert.deepEqual(result.records.map((record) => record.nativeId), [idActive]);
    assert.equal(result.records[0].name, "active");
    assert.equal(result.records[0].turnId, "turn-a");
    assert.deepEqual(await collectCodexExact({ codexRoot: root, threadId: idDone }), {
      threadId: idDone, turnId: "turn-b2", status: "completed", startedAt: 300, rolloutOrdinal: 2,
    });

    const incompatible = new DatabaseSync(path.join(root, "thread_history_3.sqlite"));
    incompatible.exec("CREATE TABLE thread_turns (thread_id TEXT)");
    incompatible.close();
    await assert.rejects(() => collectCodexCandidates({ codexRoot: root }), /missing columns/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Claude collector filters idle and malformed session registrations", async () => {
  const root = tempDirectory();
  const sessions = path.join(root, "sessions");
  fs.mkdirSync(sessions);
  try {
    fs.writeFileSync(path.join(sessions, "active.json"), JSON.stringify({
      pid: 100, sessionId: "33333333-3333-4333-8333-333333333333", cwd: "C:\\work",
      procStart: "134363325751189835", status: "busy", name: "active", updatedAt: 20,
    }));
    fs.writeFileSync(path.join(sessions, "idle.json"), JSON.stringify({
      pid: 101, sessionId: "44444444-4444-4444-8444-444444444444", cwd: "C:\\work",
      procStart: "134363325751189836", status: "idle",
    }));
    fs.writeFileSync(path.join(sessions, "waiting.json"), JSON.stringify({
      pid: 102, sessionId: "66666666-6666-4666-8666-666666666666", cwd: "C:\\work",
      procStart: "134363325751189837", status: "waiting", name: "waiting", updatedAt: 30,
    }));
    fs.writeFileSync(path.join(sessions, "bad.json"), "not-json");
    fs.utimesSync(path.join(sessions, "active.json"), new Date(1000), new Date(1000));
    fs.utimesSync(path.join(sessions, "waiting.json"), new Date(2000), new Date(2000));
    const result = await collectClaudeCandidates({ claudeRoot: root });
    assert.deepEqual(result.records.map((record) => record.name), ["waiting", "active"]);
    assert.equal(result.records[0].status, "waiting_input");
    assert.equal(result.skipped, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Claude exact lookup rejects registry identity changes", async () => {
  const root = tempDirectory();
  const sessions = path.join(root, "sessions");
  fs.mkdirSync(sessions);
  const sourcePath = path.join(sessions, "active.json");
  const sessionId = "33333333-3333-4333-8333-333333333333";
  try {
    fs.writeFileSync(sourcePath, JSON.stringify({
      pid: 100, sessionId, cwd: "C:\\work", procStart: "134363325751189835", status: "busy",
    }));
    assert.equal((await readExactClaudeSession({
      claudeRoot: root, sourcePath, sessionId, pid: 100, procStart: "134363325751189835",
    })).ok, true);
    assert.deepEqual(await readExactClaudeSession({
      claudeRoot: root, sourcePath, sessionId, pid: 101, procStart: "134363325751189835",
    }), { ok: false, reason: "identity_changed" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("session orchestration keeps providers separate and merges gateway records", async () => {
  const id = "55555555-5555-4555-8555-555555555555";
  const text = await listActiveAgentSessions({
    gatewayActivities: [{ provider: "gateway", agent: "codex", gatewayId: "CX-1", sessionId: "CX-1", nativeId: id, name: "managed", status: "running", cwd: "C:\\project", updatedAt: 30 }],
    collectCodex: async () => ({ records: [{ provider: "codex", agent: "codex", sessionId: id, nativeId: id, name: "native", status: "running", cwd: "C:\\native", lockPath: "lock", updatedAt: 20 }], truncated: false }),
    collectClaude: async () => ({ records: [{ provider: "claude", agent: "claude", sessionId: id, nativeId: id, name: "claude", status: "running", cwd: "C:\\claude", pid: 99, procStart: "1234567890", updatedAt: 10 }], truncated: false, skipped: 0 }),
    probe: async ({ locks, processes }) => ({
      locks: new Map(locks.map((item) => [item.id, { id: item.id, state: "held" }])),
      processes: new Map(processes.map((item) => [item.id, { id: item.id, state: "live" }])),
    }),
  });
  assert.match(text, /Gateway\/Codex \| running \| managed/);
  assert.match(text, /Claude \| running \| claude/);
});

test("session orchestration bounds an uncooperative provider", async () => {
  const text = await listActiveAgentSessions({
    totalTimeoutMs: 30,
    collectCodex: async () => new Promise(() => {}),
    collectClaude: async () => ({ records: [], truncated: false, skipped: 0 }),
  });
  assert.match(text, /当前没有/);
  assert.match(text, /Codex.*timed out/);
});

test("active collection exposes structured provider completeness", async () => {
  const result = await collectActiveAgentSessionRecords({
    executor: "claude",
    gatewayTruncated: true,
    collectCodex: async () => { throw new Error("unselected Codex collector must not run"); },
    collectClaude: async () => ({ records: [], truncated: true, skipped: 0 }),
  });
  assert.deepEqual(result.completeness, { gateway: false, codex: true, claude: false });
});

test("real Windows probe detects free and held locks plus process identity", { skip: process.platform !== "win32" }, async () => {
  const root = tempDirectory();
  const lockPath = path.join(root, "probe.lock");
  fs.writeFileSync(lockPath, "lock");
  const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const escaped = lockPath.replaceAll("'", "''");
  const holder = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    `$s=[IO.File]::Open('${escaped}','Open','Read','None'); [Console]::Out.WriteLine('ready'); [Console]::In.ReadLine(); $s.Dispose()`],
  { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  try {
    await once(holder.stdout, "data");
    const first = await runWindowsSessionProbe({
      locks: [{ id: "held", path: lockPath }],
      processes: [{ id: "self", pid: process.pid, procStart: "1234567890" }],
    });
    assert.equal(first.locks.get("held").state, "held");
    assert.equal(first.processes.get("self").state, "reused");
    const actualStart = first.processes.get("self").procStart;
    const second = await runWindowsSessionProbe({
      locks: [],
      processes: [
        { id: "self", pid: process.pid, procStart: actualStart },
        { id: "dead", pid: 4294967294, procStart: actualStart },
      ],
    });
    assert.equal(second.processes.get("self").state, "live");
    assert.equal(second.processes.get("dead").state, "exited");
    holder.stdin.end();
    await once(holder, "exit");
    const free = await runWindowsSessionProbe({ locks: [{ id: "free", path: lockPath }], processes: [] });
    assert.equal(free.locks.get("free").state, "free");
  } finally {
    holder.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
