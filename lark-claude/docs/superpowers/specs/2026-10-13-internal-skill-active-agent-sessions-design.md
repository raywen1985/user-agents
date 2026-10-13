# Internal Skill Routing and Active Agent Sessions Design

Date: 2026-10-13
Status: Revised for specification review

## Problem

The Lark gateway currently treats every new executable request as a project
task. A new task must name Codex or Claude and resolve to a configured project.
This is correct for coding work, but it prevents the gateway from handling
project-independent local utilities itself.

The first required utility is a read-only query for agent sessions that are
currently doing work on this PC. The query must cover Codex native sessions,
Claude Code native sessions, and sessions launched through this gateway. It
must not turn the gateway into a general-purpose local command executor.

## Goals

- Decide explicitly whether a message belongs to a configured project agent or
  to a registered gateway-owned internal skill.
- Execute project-independent work only when it matches an allowlisted internal
  skill.
- Add `list_active_agent_sessions` as the first internal skill.
- Report active Codex, Claude Code, and gateway sessions in one concise Lark
  response.
- Exclude completed, failed, cancelled, stopped, stale, and idle sessions.
- Degrade by provider so one unreadable or incompatible source does not hide
  results from the other sources.
- Make future internal skills additive without adding conditional branches to
  the gateway entry point.

## Non-Goals

- Executing arbitrary shell commands or free-form local tasks inside the
  gateway.
- Automatically registering skills from files found on disk.
- Modifying, resuming, cancelling, or messaging native sessions discovered by
  the query.
- Listing historical sessions that are not currently doing work.
- Replacing the existing gateway `list`, `status`, or project-session controls.
- Providing a stable public API over Codex or Claude Code private storage.

## Considered Approaches

### Pre-router keyword interception

Match phrases such as "active agent sessions" before invoking the router. This
is small initially, but synonyms are brittle and each new skill adds another
branch to message handling.

### Treat the gateway as a third executor

Model internal utilities as sessions beside Codex and Claude. This reuses the
queue, but creates project session records for short read-only queries and
weakens the distinction between allowlisted utilities and arbitrary local work.

### Explicit internal-skill action and registry

Extend the router contract with an `internal_skill` action and a validated
skill name. Dispatch only through a code-owned registry. This is the selected
approach because it preserves the existing project-task model, keeps the
allowlist auditable, and gives future internal utilities one extension point.

## Routing Contract

The intent schema adds:

- action `internal_skill`;
- nullable `skill_name`, initially restricted to
  `list_active_agent_sessions`.

The router prompt receives the registered skill names and descriptions. It may
select `internal_skill` only when the user's request matches one of those
descriptions. Project work continues to use `new` or `continue` and the current
executor/project resolution rules.

The resolver validates `skill_name` against the runtime registry even though
the JSON schema also constrains it. A missing, unknown, or disabled skill is
returned as an unsupported operation and is never executed. The router cannot
invent a handler, filesystem path, command, or argument.

The existing `list` action remains the gateway's recent-session list. Requests
that explicitly ask for all currently working agents on the PC route to
`list_active_agent_sessions`. Unsupported project-independent requests remain
`unknown` and receive help text that lists registered internal skills.

`list_active_agent_sessions` is argument-free. For this action, `executor`,
`project_alias`, `session_ref`, `session_name`, `request_ref`, and `content`
must all be null, and `needs_clarification` must be false. The resolver enforces
that invariant independently of the router. An explicit, otherwise pure active
session query wins over reply binding and does not inherit the replied session.
If the same message also names a project/executor/session or asks for additional
work, the router returns `clarify` and asks the user to send the session query
and the project work separately. It must not silently drop either intent.

## Internal Skill Registry

A focused module owns a static map from skill name to metadata and handler. The
registry exposes router-safe descriptors and a dispatch method. Registration is
performed in source code; the gateway does not scan directories or load code
named by a message.

Handlers receive explicit dependencies from the gateway. They do not receive a
shell, an executor, or unrestricted message content. The first handler receives
only an enriched immutable scheduler activity snapshot and provider-specific
filesystem/process adapters needed for the read-only query. The gateway obtains
ID/phase references from the scheduler, resolves those IDs through the store,
copies only the allowlisted display fields into plain objects, freezes the
result, and then dispatches the handler. The handler receives neither the store
nor the mutable scheduler.

Internal skills execute inline rather than creating a gateway session or task.
The gateway sends one global response keyed by the inbound message ID, using the
existing outbox deduplication path. Handler errors are sanitized before being
sent to Lark and logged with full local diagnostics.

## Definition of Active

The query reports sessions that are currently queued, running, or blocked on an
active approval/input boundary. It does not report an interactive process that
is merely open and idle.

Provider rules are:

- Gateway: the current scheduler process contains a queued or active task for
  the session. Active task phase is read from the current store row and exposed
  as `running` or `waiting_approval`; queued work is exposed as `queued`.
- Codex: the latest persisted turn status is `inProgress`, and the matching
  thread writer lock is currently held. The lock requirement removes abandoned
  `inProgress` rows left by an abnormal exit.
- Claude Code: the session registry identifies a live process instance, the
  recorded process-start identity still matches, and the registry status is not
  idle or terminal. Known terminal states include completed, failed, cancelled,
  and stopped. A live unknown non-terminal status is retained and labeled as
  reported so a newer Claude version does not silently hide active work.

Waiting states remain active because the work has not completed and may require
attention. Idle native clients and historical session files are excluded.

## Provider Collection

### Gateway sessions

Persisted session status is not used to decide activity. A continuation can be
queued while its session still says `completed`, and a process crash can leave
persisted `queued` rows after the in-memory queue is lost. The scheduler instead
exposes a read-only snapshot of its current `queue` and `active` maps. The
snapshot contains task/session IDs, queue position, and phase only. The gateway
joins those IDs to current store rows before skill dispatch as described above.

The scheduler adds `sessionId` and `taskId` to each `approvalWaiters` entry.
`activitySnapshot()` labels an active entry `waiting_approval` when a current
waiter has the same session/task pair; otherwise it is `running`. This is the
sole source of the waiting phase. The task row may remain `running`, and session
status is display metadata only, never the phase source.

Multiple scheduler entries for one session collapse to one record. Phase
precedence is `waiting_approval`, `running`, then `queued`; ties use the newest
task timestamp and then task ID. Startup recovery remains unchanged because
stale persisted rows cannot enter this snapshot. Each record is normalized with
gateway ID, executor, name, project alias/path, native ID, phase, and newest
active-task timestamp.

### Codex sessions

The collector reads the current per-user Codex data directory. For each database
family it parses the numeric suffix and selects the highest generation. It does
not fall back to an older compatible generation: if the highest generation is
incompatible, the Codex provider returns a compatibility warning rather than
reporting stale data.

The selected databases are opened with Node SQLite in read-only mode, followed
by `PRAGMA query_only=ON` and `PRAGMA busy_timeout=250`. They are not opened as
immutable because current WAL content must remain visible. The collector
validates the exact required tables and columns before querying. The latest turn
per thread is selected by `rollout_ordinal DESC`, then `started_at DESC`, then
`turn_id ASC`. After filtering the latest row to exact status `inProgress`,
candidates are ordered by `COALESCE(started_at, 0) DESC`, then
`rollout_ordinal DESC`, then `thread_id ASC`. The query requests 201 rows,
returns the first 200, and emits a truncation warning when row 201 exists.

All synchronous Codex SQLite work runs in a dedicated
`src/active-agent-codex-worker.mjs` Worker thread. The parent passes only the
selected fixed-root database paths and numeric limits. The worker validates and
queries the databases, posts a structured result, and closes every database in
`finally`. The parent terminates it at the four-second Codex deadline, so a
stalled synchronous query cannot block the gateway event loop.

Display metadata is a left join or a separate bounded lookup from `threads`.
Only `name`, `cwd`, and `updated_at_ms` are allowed. `title`, `preview`,
`first_user_message`, rollout bodies, and item content are never read. A missing
metadata row does not remove an otherwise active thread; it is shown with its
thread ID and unknown working directory.

Codex App Server remains the supported integration for creating and controlling
gateway-owned Codex work. It is not used for this cross-process query: the
official `thread/list` runtime status is scoped to the app-server process, and a
separate process reports desktop-loaded threads as `notLoaded`. The local
history/lock intersection is therefore required for desktop sessions owned by
another process.

For each candidate thread, the collector validates the ID as a UUID-like lower-
case hexadecimal identifier and checks the fixed
`thread-writer-locks/<thread-id>.lock` path through the Windows probe described
below. A sharing violation means another process currently owns the lock.
Missing or freely openable locks are stale. Access denied and unexpected I/O
errors fail the Codex provider rather than being guessed as active.

### Claude Code sessions

The collector enumerates only `~/.claude/sessions/*.json`. It validates the
minimum fields (`pid`, `sessionId`, `cwd`, `status`, and process-start identity)
and rejects malformed files independently.

Liveness is checked without WMI command-line access. The registry `procStart`
value is defined as the unsigned decimal Windows FILETIME creation timestamp
returned by `GetProcessTimes`, combining the high and low 32-bit values into one
64-bit value. The process probe opens the PID with
`PROCESS_QUERY_LIMITED_INFORMATION`, obtains that creation time, and compares
its decimal representation exactly. A reused PID, missing process, mismatched
start identity, idle state, or terminal state is not active. Access denied or an
unexpected process error fails the Claude provider instead of treating the PID
as live. The collector reads an optional name from the registry and never parses
conversation content for display.

### Windows native probe

Node's ordinary `fs.open` does not express Windows `FileShare.None`, and Node
does not expose another process's exact creation FILETIME. Production therefore
uses one repository-owned `scripts/session-probe.ps1` subprocess per skill run.
The gateway launches the fixed system executable
`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` directly with
`-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <fixed-path>`;
there is no shell and no message-derived command or path.

The helper accepts one bounded JSON request on stdin containing validated lock
paths and numeric PIDs, and returns one JSON object on stdout. Its embedded C#
P/Invoke uses `OpenProcess`, `GetProcessTimes`, and `CloseHandle`; lock checks use
`System.IO.File.Open(..., FileMode.Open, FileAccess.Read,
FileShare.None)`. Every file stream and native handle is closed in `finally`.
Windows error 2 maps to `missing`, 5 to `accessDenied`, 32/33 to `held`, and 87
from `OpenProcess` maps to `exited` after PID validation. Error 6 from a later
native-handle operation also maps to `exited` to cover a process-exit race.
Other codes are `error` with only the numeric code. A successful exclusive open
maps to `free` and never writes the file.

All lock and process checks are serialized inside that one helper invocation to
bound handle use. Input is capped at 512 total probes, stdout at 256 KiB, and the
subprocess deadline is three seconds. Timeout, nonzero exit, invalid JSON,
duplicate/missing result IDs, or extra stdout fails the affected native
providers. Stderr is retained only as a bounded local diagnostic.

## Normalization and Deduplication

Every provider returns records with this internal shape:

- `provider`: `gateway`, `codex`, or `claude`;
- `agent`: `codex`, `claude`, or `gateway`;
- `sessionId` and optional `nativeId`/`gatewayId`;
- `name`, `status`, `cwd`, optional project alias, optional PID;
- `updatedAt` when available.

Gateway rows are normalized first. Native IDs are trimmed and lower-cased after
format validation. Deduplication keys are `(agent, normalizedNativeId)`, never
the native ID alone. When a gateway row's executor and native ID match a native
record, the records merge. The result keeps gateway name, project alias/path,
and gateway IDs; native cwd, PID, and provider update time fill fields the
gateway does not own. Gateway phase wins status precedence because it describes
the remotely managed task.

If multiple active gateway records map to the same native key, they collapse by
phase precedence, newest active-task timestamp, then lexicographically smallest
gateway ID. Up to three gateway IDs are retained for diagnostics with a bounded
`+N` marker. An invalid native ID is never used as a merge key.

Native records are deduplicated before gateway merging. For duplicate
`(agent, normalizedNativeId)` keys, choose status priority first, then
`updatedAt` descending, provider source path by lower-cased ordinal order and
then original ordinal order, PID ascending with missing last, and normalized ID.
The winner supplies native name/cwd/PID fields. Duplicate count is retained only
for bounded local diagnostics and is not displayed as separate sessions.

All records are sorted deterministically by status priority
(`waiting_approval`, `running`, unknown live non-terminal, `queued`), then
`updatedAt` descending with missing values last, agent name, normalized primary
ID, and gateway ID. The formatter bounds names and paths with the existing
sanitization helpers. A
record contains agent type, name, state, IDs, project or working directory, and
PID when available. When there are no active records, the response says so
explicitly.

## Partial Failure Behavior

Providers are collected independently with `Promise.allSettled` or equivalent
isolation and explicit deadlines. Codex and Claude collection each have a four-
second deadline, the shared Windows helper has a three-second deadline, and the
whole skill has a five-second deadline. A provider failure yields one concise
warning line after successful records. It does not turn the whole skill into a
failure unless every provider fails.

At the five-second deadline the parent aborts pending asynchronous file work,
terminates the Codex Worker, and kills the Windows helper process tree through
the existing process utility. It formats already completed gateway/provider
results plus one timeout warning per unfinished provider. No synchronous SQLite
operation runs on the gateway thread.

Malformed individual Claude registry files are skipped and counted. A missing
provider directory means that provider has no active sessions. Missing or
incompatible Codex databases are reported as a Codex-source warning because
silently returning an empty list would be misleading.

Claude files are sorted by modification time descending, then lower-cased full
path ordinal ascending, then original full path ordinal ascending. Enumeration
is capped at 256 files and each file at 64 KiB. It produces at most 200 active
records and reads one additional qualifying record to detect truncation. Codex
returns at most 200 active candidates as described above. Gateway scheduler
references are ordered by phase, task timestamp, session ID, and task ID; the
snapshot retains 200 plus one to detect truncation.

Provider records are deduplicated and globally sorted before applying a
200-record aggregate cap. The formatter displays the first 30. Names are capped
at 80 characters, paths at 180, each provider diagnostic at 200, total
diagnostics at three, and the final message at 12,000 characters. Deterministic
truncation uses an explicit
`... N additional active sessions not shown` line. Hitting an input cap also
adds a provider warning so an incomplete result is never presented as complete.

Errors sent to Lark contain the provider name and a bounded category, not raw
database contents, environment values, command lines, or credentials.

## Components

- `schemas/intent.schema.json`: add the action and skill-name field.
- `prompts/route.md`: describe registered internal skills and routing priority.
- `src/resolver.mjs`: validate and resolve internal skill intents.
- `src/internal-skills.mjs`: own the static registry and dispatch contract.
- `src/active-agent-sessions.mjs`: collect, normalize, deduplicate, and format
  provider results.
- `src/scheduler.mjs`: expose a bounded read-only snapshot of in-memory queued
  and active entries, including approval-wait phase from `approvalWaiters`.
- `src/store.mjs`: support bounded joins from scheduler task/session IDs to
  current display metadata.
- `src/gateway.mjs`: inject the registry and handle resolved internal skills.
- `src/active-agent-codex-worker.mjs`: isolate synchronous Codex SQLite reads in
  a deadline-terminable Worker.
- `scripts/session-probe.ps1`: provide the fixed Windows lock/process probe.
- `test/`: cover routing, provider detection, stale filtering, deduplication,
  partial failures, and output bounds using temporary fixtures/adapters.
- `README.md`: document the supported natural-language query and allowlist
  boundary.

## Security

- Only statically registered skill names can reach a handler.
- Message text is classified but never evaluated as code or appended to a shell
  command.
- The active-session skill is read-only and uses fixed per-user data roots.
- SQLite databases are opened read-only; lock files are never written or
  deleted.
- The Windows helper receives only collector-validated fixed-root lock paths and
  numeric PIDs; it exposes no generic command execution operation.
- No process is signaled, resumed, cancelled, or inspected for full command-line
  contents.
- Output excludes prompts, conversation bodies, environment data, and secrets.
- Existing sender allowlisting, outbox deduplication, project boundaries, and
  executor approval controls remain unchanged.

## Testing and Verification

Automated tests will cover:

- exact and synonymous active-agent queries resolve to the registered skill;
- unrelated project-independent requests cannot invoke a handler;
- an invented or missing `skill_name` is rejected by the resolver/registry;
- mixed project/internal requests clarify instead of dropping either action;
- reply context does not redirect a pure explicit internal query;
- prompt-injection text cannot invent a skill, arguments, or handler;
- project tasks still require the existing executor and registered project;
- gateway activity comes from the current scheduler snapshot, not stale session
  status; approval waiters define waiting phase, gateway enrichment occurs
  before dispatch, and multiple tasks collapse with the defined precedence;
- Codex `inProgress` plus a held writer lock is included;
- stale Codex `inProgress` rows without a held lock are excluded;
- the highest Codex database generation is selected without fallback, latest
  turn ordering is deterministic, WAL rows are visible, and missing metadata is
  retained without reading conversational columns;
- a deliberately blocked/slow Codex Worker is terminated without blocking the
  gateway event loop, and completed providers still format at the total deadline;
- Claude live, start-identity-matching non-idle sessions are included;
- dead, PID-reused, idle, terminal, and malformed Claude sessions are excluded;
- gateway/native records merge only by `(agent, normalized native ID)`, with
  deterministic conflict, field, status, and ordering rules;
- one provider failure preserves other results and adds a bounded warning;
- all-provider failure returns a clear query failure;
- deadlines, file/row/probe/result/output caps produce deterministic warnings
  and truncation markers;
- Windows-only integration tests invoke the real helper against a temporary
  freely openable file, a file held with `FileShare.None`, the test process with
  its exact `GetProcessTimes` value, a deliberately wrong start value, and a
  terminated process whose validated positive PID produces error 87. Mock
  adapters remain for platform-independent unit tests;
- equal-mtime Claude files, the 201st Codex/Claude candidate, the 201st scheduler
  entry, duplicate native keys, and post-dedup aggregate truncation all follow
  the documented deterministic order and emit the required warning.

Verification will run the Node test suite, exercise the collector against the
current PC in read-only mode, restart the gateway, and send a Feishu query using
a natural phrase such as "query all currently active agent sessions on this
PC". Success means the reply includes the currently working Codex, Claude Code,
and gateway-managed work once each, excludes idle/history-only sessions, and
does not create a new project session.

## Rollout and Recovery

The change requires one gateway restart and no database migration. The router
schema and prompt ship with the registry, so they cannot intentionally select a
skill absent from that version.

If a native client's private storage layout changes, only that provider reports
an incompatibility warning; project routing and other providers continue to
work. The provider can be disabled or updated independently. Removing the
`internal_skill` action, registry wiring, and prompt entry restores the previous
behavior without changing existing gateway session data.
