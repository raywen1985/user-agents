# Stop Active Agent Session Internal Skill Design

Date: 2026-10-13
Status: Confirmed by user, pending specification review

## Problem

The gateway can list active Codex, Claude Code, and gateway-managed sessions,
but it cannot stop one of those results. The existing `cancel` action controls
only sessions created by this gateway. The requested capability is a registered
project-independent internal skill that stops one exact result from
`list_active_agent_sessions` without adding arbitrary process control.

Stopping must be scoped to one session. The gateway must never implement a
single-session request by terminating the shared Codex Desktop app-server or
the desktop application.

## Goals

- Register `stop_agent_session` as an allowlisted internal skill.
- Accept only an exact session identifier returned by the active-session query.
- Stop gateway-managed turns through the current scheduler.
- Stop one native Claude Code session after revalidating its process identity.
- Stop one native Codex turn through the owning app-server's
  `turn/interrupt` method.
- Report whether each active result is remotely stoppable.
- Verify the target has stopped before reporting success.
- Keep repeated requests safe and deterministic.
- Record a bounded local audit event without storing conversation content.

## Non-Goals

- Killing Codex Desktop, its shared app-server, or every Codex session.
- Stopping a Codex turn owned by an unreachable stdio-only app-server.
- Accepting a PID, executable path, shell command, project path, or fuzzy
  session name from a Lark message.
- Stopping idle or historical sessions that are absent from a fresh active
  snapshot.
- Adding a general process-management API.
- Reconfiguring or restarting Codex Desktop automatically.

## Selected Approach

The existing internal-skill registry remains the only dispatch mechanism. The
new skill receives one structured `session_ref` and resolves it against a fresh
active-session snapshot. It delegates to one of three provider adapters:

- Gateway adapter: call `Scheduler.cancel(gatewayId)`.
- Claude adapter: revalidate the registered PID and Windows creation FILETIME,
  then terminate only that process tree.
- Codex adapter: send `turn/interrupt` with the exact `threadId` and `turnId`
  over a configured connection to the app-server that owns the turn.

No adapter may fall back to a broader adapter. A Codex control failure never
falls back to process termination, and a Claude validation failure never falls
back to killing a process by PID alone.

## Routing Contract

The intent schema keeps the existing `internal_skill` action and adds
`stop_agent_session` to the static `skill_name` enum. It reuses the existing
nullable `session_ref` field instead of introducing generic skill arguments.

The contracts are skill-specific:

- `list_active_agent_sessions`: `session_ref` must be null and all existing
  project/executor/request/content fields must remain null.
- `stop_agent_session`: `session_ref` must be a non-empty exact ID; executor,
  project alias, session name, request reference, and content must be null.

The router may copy a UUID-like native session ID or a gateway ID from the
user's message into `session_ref`. The resolver and handler do not trust that
value merely because it passed structured routing. The handler accepts only
the known gateway-ID format or the native UUID format, recollects active
sessions, and requires the ID to identify exactly one aggregate record.

Messages such as `停止 Session <ID>`, `终止会话 <ID>`, and `停止 agent <ID>`
route to the skill. A name, directory, PID, `停止所有`, missing ID, or ambiguous
ID returns a concise clarification that asks the user to run the active-session
query and send one exact ID. A message that combines the stop request with
project work also clarifies instead of dropping either intent.

The handler receives only `sessionRef`, the inbound message ID, an immutable
fresh activity snapshot, and the explicit provider adapters. It does not
receive raw message content, a shell, the mutable store, or arbitrary paths.

## Active-Session Record Changes

The internal normalized record adds non-display control metadata:

- Codex: `turnId` from the latest exact `inProgress` row.
- Claude: `procStart` already used for liveness validation.
- All providers: `stopCapability` with `ready` and a bounded reason code.

The Codex worker already queries `turn_id`; it will return that field without
reading prompts, item bodies, previews, or titles. The formatter adds one short
suffix to every displayed row:

- `停止: 可用`
- `停止: 不可用 (control_unreachable)`

Reason codes are fixed values, not raw errors. The list output remains bounded
by its existing row and message-size limits.

An aggregate record can contain both gateway and native identities. If it has
an active gateway ID, the gateway adapter takes precedence because the
scheduler owns the exact executor client and can cancel it directly. Otherwise
the native provider adapter is used. Every gateway ID, native ID, and primary
display ID is an allowed exact alias for the same aggregate record. If one ID
matches more than one aggregate record, resolution fails closed.

## Gateway Stop Adapter

The adapter accepts one currently active gateway record and calls the existing
`Scheduler.cancel(gatewayId)`. Queued work is removed using the current queue
path. Running or approval-blocked work aborts its controller; the executor
performs its existing provider-specific interruption and cleanup.

Success requires the gateway ID to disappear from a new scheduler activity
snapshot. Database state alone is not proof of stopping. The existing scheduler
completion path remains responsible for final task/session status and user
messages.

## Claude Stop Adapter

The Claude adapter never accepts a message-supplied PID. It receives the PID,
session ID, registry file path, and `procStart` from the freshly collected
record. Immediately before termination it reruns the Windows process probe and
requires all of the following:

- the session registry still maps the same session ID to the same PID and
  `procStart` value;
- the PID is live;
- its exact creation FILETIME still equals `procStart`;
- the session status is still non-terminal and non-idle.

The adapter then terminates that PID's process tree. This is process-level
termination, but Claude Code's registry identifies one session process, so the
target remains session-specific. It does not search by executable name or kill
other Claude processes.

The adapter polls the exact PID/process-start pair for up to five seconds.
Success means that process instance is no longer live. A timeout or access
error is a failure and is not retried with broader privileges or a name-based
kill.

## Codex Stop Adapter

Official Codex app-server supports
`turn/interrupt { threadId, turnId }`. The target turn is process-owned, so a
new unrelated app-server is not assumed to control a turn merely because both
processes can read the same SQLite state.

The gateway supports a configured local Codex control transport only when all
of these conditions hold:

- it connects to the same app-server process that owns the active turn;
- the transport is either the managed local control socket through
  `codex app-server proxy` or an authenticated loopback WebSocket;
- WebSocket endpoints resolve only to loopback addresses and use a capability
  token stored in a local file; token contents never appear in configuration,
  logs, errors, or Lark output;
- the initialized control connection reports the target thread through
  `thread/loaded/list`;
- the fresh persisted latest turn still has the exact `turnId` and
  `inProgress` status.

Only after those checks does the adapter send `turn/interrupt`. It then polls
the read-only turn state for up to five seconds. Success requires the exact turn
to become `interrupted` or otherwise leave `inProgress` while the thread writer
lock is released or the owning server reports completion. A different new turn
starting on the same thread does not convert the requested stop into success;
the result remains tied to the captured turn ID.

Before native Codex stopping is enabled, an automated compatibility test must
prove cross-connection control against the installed Codex version: client A
starts a disposable long-running turn on one app-server, client B connects to
that same server, confirms the thread in `thread/loaded/list`, interrupts the
exact turn, and observes `status: interrupted`. If this test fails, the
production adapter reports `control_incompatible` and does not send stop
requests.

The currently running Codex Desktop app-server uses stdio only. Its sessions
remain visible but are marked `control_unreachable` until the owning Desktop
runtime exposes a configured, authenticated local control connection. The
gateway does not restart or silently reconfigure Desktop to obtain one.

## Idempotency and Audit

The inbound message ID continues to deduplicate the Lark reply through the
outbox. A small `agent_stop_events` table records:

- unique inbound message ID;
- agent and provider;
- normalized session ID and optional captured turn ID;
- outcome code;
- created and completed timestamps.

It does not store the Lark message body, prompt, session title, command line,
environment, token, or raw provider error. A repeated delivery of the same
message returns the stored outcome without issuing another stop.

If a later message targets an ID that is no longer active, the handler checks
the newest successful bounded audit event for that normalized ID. A recent
success returns `Session 已停止。`; otherwise it returns `未找到活动 Session`.
Audit retention is bounded by age or row count during gateway maintenance.

## Responses and Error Handling

Success replies include only agent type, normalized session ID, and the verified
result. Expected failures use fixed public messages:

- `invalid_session_ref`: ask for one exact query result ID.
- `not_active`: the target is not in the fresh active snapshot.
- `ambiguous_session_ref`: the ID maps to more than one active aggregate.
- `control_unreachable`: the owning Codex app-server has no reachable control
  transport.
- `control_incompatible`: cross-connection interruption is not supported by the
  installed Codex version.
- `identity_changed`: the Claude PID or creation identity changed.
- `stop_timeout`: the exact target did not stop within the deadline.
- `provider_error`: an unexpected bounded provider failure.

Full local diagnostics go to the gateway log with IDs and error categories.
Raw process command lines, credentials, environment values, prompts, and
conversation content are excluded.

## Components

- `schemas/intent.schema.json`: allow the new registered skill name.
- `prompts/route.md`: document exact-ID stop routing and mixed-intent behavior.
- `src/resolver.mjs`: enforce the per-skill field contract.
- `src/internal-skills.mjs`: register `stop_agent_session` with its required
  `session_ref` metadata.
- `src/active-agent-codex-worker.mjs`: retain the latest `turnId`.
- `src/active-agent-sessions.mjs`: expose structured records separately from
  formatting and attach stop capabilities.
- `src/stop-agent-session.mjs`: resolve one exact record, dispatch to adapters,
  verify the result, and format bounded outcomes.
- `src/codex-control-client.mjs`: initialize the configured local control
  transport and perform bounded app-server requests.
- `src/scheduler.mjs`: reuse the existing cancellation and activity snapshot.
- `src/store.mjs`: migrate and access bounded stop audit events.
- `scripts/session-probe.ps1`: extend the fixed helper only if process-tree
  termination cannot be implemented safely through a fixed Node spawn.
- `test/`: add resolver, adapter, compatibility, audit, and end-to-end tests.
- `README.md`: document query, capability labels, exact stop syntax, and Codex
  control prerequisites.

## Security

- Dispatch remains restricted to statically registered skill names.
- The only user-controlled stop value is a validated exact session ID.
- PIDs, paths, endpoints, tokens, and commands come from trusted configuration
  or freshly validated provider records, never from the message.
- Claude process identity is checked immediately before signaling.
- Codex control is limited to one exact thread/turn pair on the owning server.
- A Codex stop never kills a process or closes Desktop.
- Control connections have short deadlines, bounded messages, and no automatic
  non-loopback network access.
- Secrets and conversation content are absent from audit rows and public
  responses.
- Existing sender allowlisting and outbox deduplication remain unchanged.

## Testing and Verification

Automated tests cover:

- schema and router selection for exact-ID stop phrases;
- missing, malformed, name-only, PID-only, ambiguous, invented-skill, mixed
  project/skill, and prompt-injection requests;
- resolver enforcement of argument-free list versus exact-reference stop;
- exact alias resolution and gateway/native merged-record precedence;
- gateway queued, running, approval-waiting, already-finished, and cancellation
  race paths;
- Claude live identity, PID reuse, registry mutation, access denial, process
  exit race, exact process-tree termination, timeout, and no name-based fallback;
- Codex control-unreachable and incompatible states;
- two-client Codex compatibility, exact thread/turn request shape, unrelated
  turn preservation, target completion race, timeout, authentication failure,
  and the prohibition on app-server/Desktop termination;
- audit deduplication, recent already-stopped replies, retention bounds, and
  exclusion of message and conversation bodies;
- bounded public errors and logging fields;
- active-session formatter capability labels and output limits.

Verification runs the full Node test suite, real Windows probe tests, the
disposable two-client Codex app-server test, and a sacrificial Claude process
test. After gateway restart, a Feishu end-to-end test queries active sessions,
stops a dedicated test session by its displayed ID, confirms the verified reply,
and confirms no project session or task was created. Existing user work is never
used as a stop-test target.

## Rollout and Recovery

The database migration is additive. The list skill can ship capability labels
before any native Codex control endpoint is configured; such Codex rows clearly
show `control_unreachable`.

Rollout order is registry/schema, structured activity records, gateway and
Claude adapters, Codex compatibility probe/control adapter, audit, tests,
documentation, then gateway restart and sacrificial end-to-end verification.

If a provider adapter becomes incompatible, disable only that adapter and mark
its records unavailable. Removing the new skill registration and router enum
entry restores the previous behavior; stop audit rows may remain unused without
affecting project sessions or the active-session query.
