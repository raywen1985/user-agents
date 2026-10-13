# Internal Skill Routing and Active Agent Sessions Design

Date: 2026-10-13
Status: Approved for specification review

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

## Internal Skill Registry

A focused module owns a static map from skill name to metadata and handler. The
registry exposes router-safe descriptors and a dispatch method. Registration is
performed in source code; the gateway does not scan directories or load code
named by a message.

Handlers receive explicit dependencies from the gateway. They do not receive a
shell, an executor, or unrestricted message content. The first handler receives
only the gateway store and provider-specific filesystem/process adapters needed
for the read-only query.

Internal skills execute inline rather than creating a gateway session or task.
The gateway sends one global response keyed by the inbound message ID, using the
existing outbox deduplication path. Handler errors are sanitized before being
sent to Lark and logged with full local diagnostics.

## Definition of Active

The query reports sessions that are currently queued, running, or blocked on an
active approval/input boundary. It does not report an interactive process that
is merely open and idle.

Provider rules are:

- Gateway: session status is `queued`, `running`, or `waiting_approval`.
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

The store adds a bounded query for the active status set. Each row is normalized
with gateway ID, executor, name, project alias/path, native ID, status, and last
update time.

### Codex sessions

The collector reads the current per-user Codex data directory. It discovers the
newest compatible `thread_history_*.sqlite` and `state_*.sqlite` generations,
opens them read-only, and validates the required tables and columns before
querying. It obtains the latest turn per thread from `thread_turns`, filters for
`inProgress`, and joins display metadata from `threads`.

Codex App Server remains the supported integration for creating and controlling
gateway-owned Codex work. It is not used for this cross-process query: the
official `thread/list` runtime status is scoped to the app-server process, and a
separate process reports desktop-loaded threads as `notLoaded`. The local
history/lock intersection is therefore required for desktop sessions owned by
another process.

For each candidate thread, the collector checks the corresponding
`thread-writer-locks/<thread-id>.lock`. On Windows it attempts a non-mutating
exclusive open: a sharing violation means another process currently owns the
lock. Missing or freely openable locks are treated as stale. Other I/O errors
fail the Codex provider rather than being guessed as active.

### Claude Code sessions

The collector enumerates only `~/.claude/sessions/*.json`. It validates the
minimum fields (`pid`, `sessionId`, `cwd`, `status`, and process-start identity)
and rejects malformed files independently.

Liveness is checked without WMI command-line access. The process adapter first
checks that the PID exists, then compares the registry's process-start identity
with the current process instance where the platform exposes it. A reused PID,
missing process, mismatched start identity, idle state, or terminal state is not
active. The collector reads an optional name from the registry and never parses
conversation content for display.

## Normalization and Deduplication

Every provider returns records with this internal shape:

- `provider`: `gateway`, `codex`, or `claude`;
- `agent`: `codex`, `claude`, or `gateway`;
- `sessionId` and optional `nativeId`/`gatewayId`;
- `name`, `status`, `cwd`, optional project alias, optional PID;
- `updatedAt` when available.

Gateway rows are normalized first. When a gateway row has a native ID matching a
Codex or Claude record, the two records are merged. The result keeps the gateway
ID for remote follow-up and the native metadata for diagnostics. It is labeled
as a gateway-managed Codex or Claude session rather than displayed twice.

Remaining native records are sorted by provider and most recent activity. The
formatter bounds names and paths with the existing sanitization helpers. A
record contains agent type, name, state, IDs, project or working directory, and
PID when available. When there are no active records, the response says so
explicitly.

## Partial Failure Behavior

Providers are collected independently with `Promise.allSettled` or equivalent
isolation. A provider failure yields one concise warning line after successful
records. It does not turn the whole skill into a failure unless every provider
fails.

Malformed individual Claude registry files are skipped and counted. A missing
provider directory means that provider has no active sessions. Missing or
incompatible Codex databases are reported as a Codex-source warning because
silently returning an empty list would be misleading.

Errors sent to Lark contain the provider name and a bounded category, not raw
database contents, environment values, command lines, or credentials.

## Components

- `schemas/intent.schema.json`: add the action and skill-name field.
- `prompts/route.md`: describe registered internal skills and routing priority.
- `src/resolver.mjs`: validate and resolve internal skill intents.
- `src/internal-skills.mjs`: own the static registry and dispatch contract.
- `src/active-agent-sessions.mjs`: collect, normalize, deduplicate, and format
  provider results.
- `src/store.mjs`: add an active gateway-session query.
- `src/gateway.mjs`: inject the registry and handle resolved internal skills.
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
- project tasks still require the existing executor and registered project;
- gateway active statuses are included and terminal statuses are excluded;
- Codex `inProgress` plus a held writer lock is included;
- stale Codex `inProgress` rows without a held lock are excluded;
- Claude live, start-identity-matching non-idle sessions are included;
- dead, PID-reused, idle, terminal, and malformed Claude sessions are excluded;
- gateway/native records are merged by native ID;
- one provider failure preserves other results and adds a bounded warning;
- all-provider failure returns a clear query failure;
- names, paths, errors, and record counts are bounded and sanitized.

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
