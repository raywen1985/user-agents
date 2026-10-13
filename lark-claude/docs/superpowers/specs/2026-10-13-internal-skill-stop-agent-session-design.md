# Stop Active Agent Session Internal Skill Design

Date: 2026-10-13
Status: Approved after specification review; pending user review

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
- Accept only an exact short-lived stop reference returned by the
  active-session query.
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
active-session query creates one opaque short-lived stop reference for each
unambiguous controllable result. The new skill receives that reference in the
structured `session_ref` field, resolves its bound target, and delegates to one
of three provider adapters:

- Gateway adapter: fence and validate the bound task set with
  `Scheduler.prepareCancel(...)`, then apply only that plan with
  `Scheduler.commitCancel(...)`.
- Claude adapter: revalidate the registered PID and Windows creation FILETIME
  while retaining the opened process handle, then terminate only that exact
  process through the retained handle.
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
- `stop_agent_session`: `session_ref` must be a non-empty exact stop reference; executor,
  project alias, session name, request reference, and content must be null.

The router may copy only a `ST-` stop reference from the user's message into
`session_ref`. Stop references contain 128 random bits encoded as upper-case
hex and are created only by the registry-owned list handler. They expire after
10 minutes and bind one displayed row to one exact provider target. The
resolver and handler do not trust a reference merely because it passed
structured routing; it must exist, be unexpired, and remain unused or be tied
to an idempotent prior result.

Messages such as `停止 Session <ST-reference>`, `终止会话 <ST-reference>`, and
`停止 agent <ST-reference>` route to the skill. A name, directory, PID, raw
native/gateway ID, `停止所有`, missing reference, expired reference, or
ambiguous target returns a concise clarification that asks the user to run the
active-session query and send one exact `停止ID`. A message that combines the stop request with
project work also clarifies instead of dropping either intent.

The handler receives only `sessionRef`, the inbound message ID, the bounded
target binding loaded through a narrow store method, and the explicit provider
adapters. It does not receive raw message content, a shell, unrestricted store
access, or arbitrary message-derived paths.

## Active-Session Record Changes

The internal normalized record adds non-display control metadata:

- Codex: `turnId` from the latest exact `inProgress` row.
- Claude: `procStart` already used for liveness validation.
- All providers: `stopCapability` with `ready` and a bounded reason code.
- Displayed controllable rows: one opaque `stopRef` bound to the exact target.

The Codex worker already queries `turn_id`; it will return that field without
reading prompts, item bodies, previews, or titles. Display collection may stay
capped, but its rows are never sufficient authority for minting a stop
reference. Before formatting each candidate row, the list handler performs an
uncapped exact-owner lookup keyed by the aggregate's stable provider identity.
That lookup scans the scheduler's complete in-memory state and performs the
provider-specific exact native lookup. It must prove one control owner, the
exact current gateway task-ID set or native turn/process identity, and a
complete non-truncated result. A second owner, incomplete source, timeout, or
truncation suppresses the reference and returns a bounded capability reason.
For each remaining dynamically verified controllable row it creates one
`agent_stop_targets` binding. The formatter adds one short suffix:

- `停止ID: ST-<32 hex characters>`
- `停止: 不可用 (control_unreachable)`

Reason codes are fixed values, not raw errors. The list output remains bounded
by its existing row and message-size limits.

An aggregate record can contain both gateway and native identities. If the
uncapped owner lookup finds exactly one active gateway ID, the bound gateway
adapter takes precedence because the scheduler owns the exact executor client;
the binding includes the sorted complete task-ID set observed by that lookup.
Otherwise the native provider adapter is used. Native IDs, gateway IDs, names,
PIDs, and hidden secondary IDs are never accepted as stop aliases. An
aggregate with multiple owners, including a gateway owner hidden beyond a
display collector's cap, is marked `ambiguous_control_owner` and receives no
stop reference.

## Exact Target Revalidation

Stop execution never reruns the capped display collector and interprets an
omitted row as inactive. It repeats the same uncapped exact-owner lookup used
before minting and requires the same single owner and exact bound target. A new
owner, missing bound owner, or changed gateway task set fails closed as
`stale_target`; multiple owners fail as `ambiguous_control_owner`. The stop
binding selects a provider-specific exact lookup that bypasses display limits:

- Gateway scans the scheduler's complete in-memory entries for the bound
  gateway ID and requires exact set equality with the sorted task IDs captured
  when the reference was minted.
- Codex queries the highest database generation with an exact `thread_id`
  predicate, validates the bound `turnId`, and checks the exact writer lock.
- Claude rereads the bound registry file only after canonicalizing it beneath
  `~/.claude/sessions`, then validates its bound session ID and process identity.

These lookups remain bounded by one target and the existing provider deadlines.
A missing source, incompatible schema, provider timeout, probe error, or
truncated result from any supporting ownership query returns
`snapshot_incomplete` or `provider_error`; it must not be converted to
`not_active`. Only a complete exact lookup can report `not_active` or
`already_finished`.

## Gateway Stop Adapter

The adapter accepts a binding for exactly one gateway session and the exact
sorted task-ID set captured when the stop reference was minted. Cancellation is
a two-phase scheduler protocol:

1. `prepareCancel(gatewayId, expectedTaskIds)` runs in one synchronous
   event-loop critical section. It installs a per-session cancellation fence,
   reads the complete current active/queued task set, and requires exact set
   equality with `expectedTaskIds`. It performs no task cancellation, queue
   removal, waiter rejection, or abort. On mismatch it removes the fence and
   returns `stale_target`; on success it returns an opaque in-memory plan tied
   to that gateway ID, exact set, and fence generation.
2. The operation row is committed as `signaling` with the same exact task set
   and plan generation before any cancellation side effect.
3. `commitCancel(plan)` revalidates the live fence generation, then removes and
   marks cancelled only the plan's queued tasks, removes and rejects only their
   approval waiters, and aborts only the plan's active task. It never captures
   later work or widens the task set.

If database commit fails before step 2, `releaseCancel(plan)` removes the fence
without signaling. While a valid fence remains, `enqueue()` rejects new work
for that session with `Session 正在停止，请稍后重试。`; the gateway does not create
or announce a queued task for that rejected continuation. The fence is removed
only after verification or bounded failure cleanup. Success requires every
bound task ID to disappear from scheduler activity and reach a cancelled
terminal state. A task that completed before preparation is `already_finished`
or `stale_target`, not stopped. Work submitted after the fence is removed is a
new request and is not part of the stop.

Startup recovery reuses the task set persisted on the operation and first
reads the durable status of every bound task ID. If every bound task is
cancelled, it verifies success without preparing again. If every bound task is
still active or queued and the complete current scheduler set equals the bound
set, it may call `prepareCancel(gatewayId, expectedTaskIds)` and commit only
that plan. If every task finished naturally, the result is
`already_finished`. A partial or mixed state that cannot attribute all bound
tasks to one outcome becomes `uncertain`; an added or replaced current task set
becomes `stale_target`. Recovery never replaces the persisted set with a fresh
capture. The existing scheduler completion path remains responsible for final
task/session status and user messages.

## Claude Stop Adapter

The Claude adapter never accepts a message-supplied PID. It receives the PID,
session ID, registry file path, and `procStart` from the stop-target binding.
It rereads the registry immediately before termination and requires it to map
the same session ID to the same PID, `procStart`, and non-terminal status.

The fixed Windows helper then performs one identity-safe atomic operation. It
opens the PID with query, synchronize, and terminate rights, retains that
handle, and through the same handle requires all of the following:

- the PID is live;
- its exact creation FILETIME still equals `procStart`;
- `GetExitCodeProcess` is exactly `STILL_ACTIVE`.

Without closing or reopening the handle, the helper calls `TerminateProcess`
for only that exact root process and waits on the retained handle. It does not
invoke `taskkill`, search by executable name, rediscover by PID, or terminate a
descendant tree. Descendant cleanup is explicitly outside scope because native
Claude sessions were not created in a gateway-owned Windows Job Object and
their descendants cannot be attributed atomically after the fact.

Success requires `TerminateProcess` to succeed and the retained handle to
become signaled within five seconds. If the process exits before termination,
the helper returns internal `already_exited`, which maps to the public and
audited `already_finished` outcome and is not counted as a successful stop; PID
reuse cannot retarget the retained handle. A timeout or access error is a
failure and is not retried with broader privileges or a name-based kill.

## Codex Stop Adapter

Official Codex app-server supports
`turn/interrupt { threadId, turnId }`. The target turn is process-owned, so a
new unrelated app-server is not assumed to control a turn merely because both
processes can read the same SQLite state.

Configuration adds an optional `gateway.codexControl` object:

```json
{
  "endpoints": [
    { "id": "desktop", "transport": "proxy", "socketPath": "..." },
    { "id": "local-ws", "transport": "websocket",
      "url": "ws://127.0.0.1:4500", "tokenFile": "..." }
  ],
  "connectTimeoutMs": 1000,
  "requestTimeoutMs": 2000,
  "maxFrameBytes": 262144
}
```

There are at most four endpoints and their IDs are unique. Timeouts are clamped
to 250-5000 ms and `maxFrameBytes` to 16-512 KiB. A proxy endpoint invokes the
resolved Codex executable with fixed `app-server proxy --sock <path>` arguments.
Its canonical socket path must be a non-reparse entry beneath the fixed
`~/.codex/app-server-control` root. A WebSocket URL must use literal
`127.0.0.1` or `[::1]`, an explicit port, no user info, query, or fragment, and
`ws:` only. Its token file must be a regular non-reparse file no larger than
4 KiB beneath `%LOCALAPPDATA%/lark-claude/secrets`; token contents never appear
in configuration, logs, errors, or Lark output. Endpoint values come only from
validated local configuration, never from a message or stop binding.

Connections are opened on demand, initialized once, bounded by the configured
frame and time limits, and closed after capability probing or stopping. For one
target the adapter probes endpoints in configuration order but requires exactly
one endpoint to report both:

- the target thread in `thread/loaded/list`; and
- `thread/read` runtime state for the exact latest `turnId` as `inProgress`.

Zero owners is `control_unreachable`; more than one is
`ambiguous_control_owner`. Membership alone is insufficient. A list row gets a
stop reference only after this ownership probe succeeds, so `ready` means
dynamically verified for that exact thread and turn rather than merely
configured.

At stop time the adapter repeats the ownership and exact-turn checks. If the
turn completed or failed before the request, the result is `already_finished`.
Only after an exact active match does it send `turn/interrupt`. A successful
stop requires an accepted `{}` response and subsequent observation of that
exact turn with status `interrupted` within five seconds. Natural completion,
failure, or a different new turn is `completion_race`, not a successful stop
and not a successful audit event.

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

`agent_stop_targets` stores the random stop reference, provider, normalized
agent/session identity, the exact gateway/task set or native turn/process
identity, trusted source locator, capability code, creation time, and expiry.
It stores no display name or conversation content. Targets expire after 10
minutes; cleanup retains at most the newest 500 unexpired rows.

`agent_stop_operations` is the target-level audit and concurrency boundary. It
has an immutable bounded `provider_target_key` derived from the canonical exact
target tuple:

- Gateway: gateway ID plus the sorted bound task-ID set;
- Codex: validated endpoint-owner ID, thread ID, and turn ID;
- Claude: session ID, PID, and creation FILETIME.

It stores the provider/session identity, exact target proof, state, bounded
outcome code, execution owner epoch/token, attempt count, and timestamps. The
target key is a fixed-size digest of the canonical tuple; the exact non-secret
fields needed for verification remain in their typed columns. A nullable
`active_operation_key` initially equals the target key and has a unique index.
It is the concurrency lock for one operation generation. Its state machine is:

- `pending`: transactionally reserved before any provider side effect;
- `signaling`: committed immediately before the adapter performs the exact
  interrupt or retained-handle termination;
- `completed`: the verified terminal outcome was committed;
- `uncertain`: recovery cannot prove whether the requested side effect caused
  the target to stop.

`agent_stop_ref_claims` has `stop_ref` as its primary key and maps every used
reference to exactly one operation. `agent_stop_requests` maps each unique
inbound message ID to one operation and its outbox reply. Before serving work,
each gateway process claims a singleton instance-owner record in an immediate
SQLite transaction. The record contains its PID, Windows creation FILETIME,
and a random startup epoch. Replacement is allowed only when an exact process
probe proves the prior PID/FILETIME instance is gone; a live, inaccessible, or
unverifiable prior owner makes the new process fail closed. The owner record is
never deleted by the owning process. On graceful shutdown it is marked
`draining` with the same PID, FILETIME, and epoch, and remains as a tombstone
until a later startup proves that exact process instance is gone and replaces
it. Each execution attempt creates a separate random 128-bit owner token. The
claim method runs in one SQLite transaction: it validates the target, inserts
or finds the operation protected by the unique active-operation key, inserts
or verifies the unique reference claim, creates the request mapping, and
grants execution ownership only through a compare-and-swap from an unowned
`pending` operation to the current epoch and token. A reference claim may never
be rebound to a different operation.

A second message using the same reference always reuses the operation named by
its immutable reference claim. Another fresh reference bound to the same exact
target gets its own reference-claim row pointing to the operation holding that
target's active-operation key. Both wait for or return the shared result and
never invoke another adapter. A redelivery of the same message reuses its
request mapping. The outbox dedupe key is derived from the request's message
ID, so every distinct request can receive the shared bounded result without
repeating the side effect. Existing `acceptInbox()` may discard a redelivered
Lark event; therefore duplicates do not depend on rerunning the handler.

A terminal pre-signal outcome that proves no provider side effect occurred
sets `active_operation_key` to null in the same terminalization transaction.
This includes validation/capability failures, `stale_target`,
`already_finished`, `snapshot_incomplete`, and a pre-signal `provider_error`.
Its existing stop reference remains permanently bound to that result, but a
later freshly minted reference may create a new operation generation for the
same target key after conditions recover. Any operation that reached
`signaling`, and every verified success or `uncertain` result, retains the
unique active-operation key for its full retention period. Two fresh references
racing after a released generation still converge on one new operation through
the unique index.

Every state transition and ownership release compares operation ID, current
state, owner epoch, and owner token. The owner has no time-based lease, and no
same-process caller may steal ownership: all provider calls have bounded
deadlines, and avoiding overlapping signalers takes priority over wall-clock
lease expiry. Contenders wait at most 10 seconds for the shared operation and
then return the bounded `stop_in_progress` response without signaling; a later
request can observe the final shared result. A pre-signal validation outcome
terminalizes the operation. An unexpected exception before `signaling`
atomically clears ownership and increments the attempt count in `finally`, so
another caller can retry; after two such attempts it terminalizes as
`provider_error`. An exception after `signaling` triggers bounded exact
verification and terminalizes as `completed` or `uncertain` before releasing
ownership. Terminal transitions clear the matching epoch/token in the same
compare-and-swap transaction. A signaling operation never returns to
`pending`.

Graceful shutdown first marks the instance record `draining` and stops
accepting new work. It releases owned pre-signal `pending` attempts using the
same compare-and-swap rules and performs bounded exact verification for owned
`signaling` attempts. Anything not terminalized before the drain deadline
keeps its epoch/token and the instance tombstone; the exiting process never
clears the PID/FILETIME proof. The next process can recover those attempts only
after its startup transaction proves the recorded process instance is gone.

On startup, the new epoch may reclaim operations owned by an older epoch only
after the singleton ownership transaction proves the older gateway process is
gone. The startup code probes the owner snapshot, begins an immediate
transaction, and proceeds only if the singleton row still matches that exact
snapshot. In the same transaction that replaces the singleton record, it
assigns the new epoch and a distinct recovery token to every stranded
nonterminal operation, including operations left by still older epochs. This
preserves a continuous, durable proof chain even if the new process crashes
before recovery begins. Startup then recovers only the operations carrying its
epoch/tokens and also scans every request mapping that lacks an outbox row,
regardless of operation state.

For `pending`, recovery may perform the original exact adapter operation after
claiming execution ownership. For `signaling`, it first performs
provider-specific exact verification. Gateway recovery follows the
phase-aware rules above: every persisted task must be cancelled to prove
success, while retry is allowed only when the exact complete bound set remains
wholly active or queued. Codex turn status `interrupted` proves success. If a
Claude process is already gone, attribution cannot be proven and the operation
is `uncertain`; if the same bound process instance is still live, recovery may
retry the retained-handle termination once because the operation is
identity-bound and idempotent. Natural completion is `already_finished`, not
success. Recovery never substitutes a new PID, turn, task, reference, or
endpoint owner.

Terminalization commits the operation outcome and outbox rows for every
currently mapped request in one transaction. Claiming an already-terminal
operation creates the new request mapping and its deterministic outbox reply in
the same transaction. Startup's missing-outbox scan repairs legacy or
interrupted mappings for terminal operations and leaves nonterminal mappings
for their exclusively owned recovery. Thus a crash cannot commit a visible
terminal result while permanently losing a request's reply.

Terminal and uncertain operations, reference claims, and request mappings are
retained for 30 days with a hard cap of 5,000 newest operations. Cleanup never
removes nonterminal operations or their claims. Audit rows exclude
the Lark message body, prompt, session title, command line, environment, token,
raw provider error, and token-file contents.

## Responses and Error Handling

Success replies include only agent type, normalized session ID, stop reference,
and the verified result. Expected failures use fixed public messages:

- `invalid_session_ref`: ask for one exact `停止ID` from a query result.
- `expired_session_ref`: ask the user to query again for a fresh stop reference.
- `not_active`: a complete exact lookup proves the target is not active.
- `already_finished`: the captured work completed before interruption.
- `stale_target`: exact ownership or the bound gateway task set changed after
  the stop reference was minted.
- `completion_race`: Codex accepted interruption but the turn did not finish as
  `interrupted`.
- `ambiguous_control_owner`: more than one control target or endpoint owns the
  displayed aggregate.
- `control_unreachable`: the owning Codex app-server has no reachable control
  transport.
- `control_incompatible`: cross-connection interruption is not supported by the
  installed Codex version.
- `identity_changed`: the Claude PID or creation identity changed.
- `snapshot_incomplete`: exact revalidation could not produce a complete result.
- `stop_timeout`: the exact target did not stop within the deadline.
- `stop_in_progress`: another request owns the same exact stop operation and
  did not finish within the bounded wait; no second signal was sent.
- `uncertain`: recovery cannot attribute the observed stopped state to the
  request.
- `provider_error`: an unexpected bounded provider failure.

Full local diagnostics go to the gateway log with IDs and error categories.
Raw process command lines, credentials, environment values, prompts, and
conversation content are excluded.

## Components

- `schemas/intent.schema.json`: allow the new registered skill name.
- `prompts/route.md`: document exact-stop-reference routing and mixed-intent behavior.
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
- `src/scheduler.mjs`: add fenced `prepareCancel`/`commitCancel` cancellation
  and uncapped exact activity lookup.
- `src/store.mjs`: migrate and access bounded stop targets, reference claims,
  target operations, request mappings, instance/execution ownership, and audit
  state.
- `scripts/session-probe.ps1`: add retained-handle identity validation,
  termination, and wait operations for one exact Claude root process.
- gateway configuration/schema: validate the bounded Codex control endpoint
  structure and secret-file constraints.
- `test/`: add resolver, adapter, compatibility, audit, and end-to-end tests.
- `README.md`: document query, capability labels, exact stop syntax, and Codex
  control prerequisites.

## Security

- Dispatch remains restricted to statically registered skill names.
- The only user-controlled stop value is a validated opaque stop reference.
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

- schema and router selection for exact-stop-reference phrases;
- missing, malformed, name-only, PID-only, ambiguous, invented-skill, mixed
  project/skill, and prompt-injection requests;
- resolver enforcement of argument-free list versus exact-reference stop;
- one stop reference per displayed row, expiry, raw-ID rejection, uncapped
  owner validation before minting, hidden second-owner rejection, incomplete
  snapshot suppression, and gateway/native precedence;
- targeted exact revalidation bypasses display caps and fails closed on source,
  schema, timeout, probe, or truncation errors;
- gateway queued, running, approval-waiting, exact list-time task-set binding,
  changed-task-set rejection, multiple-continuation, already-finished,
  concurrent-enqueue, prepare/commit crash recovery with all-cancelled,
  all-active, all-naturally-finished, and mixed-status cases, and cancellation
  races;
- Claude live identity, PID reuse, registry mutation, access denial, process
  exit and PID-reuse-before-signal races, retained-handle root termination,
  timeout, descendant preservation, and no name-based fallback;
- Codex control-unreachable and incompatible states;
- two-client Codex compatibility, exact thread/turn request shape, unrelated
  turn preservation, zero/multiple endpoint ownership, target completion race,
  exact interrupted-status verification, timeout, endpoint and token-file
  validation, authentication failure, and the prohibition on app-server/Desktop
  termination;
- audit claims for same-reference/different-message and
  different-reference/same-target concurrency, crash points before and after
  signaling, instance epoch and owner-token compare-and-swap behavior,
  bounded contender waiting, pre/post-signal exceptions, terminal/outbox
  atomicity, missing-outbox startup repair, fresh-reference recovery after a
  no-signal terminal failure, shutdown during `signaling` with tombstone
  takeover, startup reconciliation, uncertain attribution, exact retention
  bounds, and exclusion of message and conversation bodies;
- bounded public errors and logging fields;
- active-session formatter capability labels and output limits.

Verification runs the full Node test suite, real Windows probe tests, the
disposable two-client Codex app-server test, and a sacrificial Claude process
test. After gateway restart, a Feishu end-to-end test queries active sessions,
stops a dedicated test session by its displayed `停止ID`, confirms the verified
reply, and confirms no project session or task was created. Existing user work
is never used as a stop-test target.

## Rollout and Recovery

The database migration is additive. It adds bounded stop-target,
stop-operation, stop-reference-claim, and stop-request tables plus their
indexes and outbox relationships, together with one singleton gateway-instance
owner record. The list skill can ship capability labels before any native Codex
control endpoint is configured; such Codex rows clearly show
`control_unreachable`.

Rollout order is registry/schema, structured activity records, gateway and
Claude adapters, Codex compatibility probe/control adapter, audit, tests,
documentation, then gateway restart and sacrificial end-to-end verification.

If a provider adapter becomes incompatible, disable only that adapter and mark
its records unavailable. Removing the new skill registration and router enum
entry restores the previous behavior; stop target/audit rows may remain unused
without affecting project sessions or project tasks.
