# Precise Agent Session Stop Implementation Plan

Date: 2026-10-13
Design: `../specs/2026-10-13-internal-skill-stop-agent-session-design.md`
Status: Ready for implementation

## Delivery Rules

- Work test-first in the order below. Keep each step independently reviewable.
- Never test stopping against an existing user Session. Native integration and
  Feishu end-to-end tests must create disposable Gateway, Claude, or Codex
  targets and verify their identities before signaling.
- Never add a Codex process-kill fallback. An unreachable Codex owner remains
  `control_unreachable`.
- Never accept message-derived PIDs, paths, endpoint URLs, tokens, native IDs,
  gateway IDs, or names as stop targets. Only `ST-` references may enter the
  stop handler.
- Preserve unrelated working-tree changes and keep commits scoped to the files
  named by each step.

## 1. Lock the Routing and Registry Contract

Files:

- Modify `schemas/intent.schema.json`.
- Modify `prompts/route.md`.
- Modify `src/internal-skills.mjs`.
- Modify `src/resolver.mjs`.
- Modify `test/gateway.test.mjs`.

Work:

- Add failing tests for valid `stop_agent_session` routing with exactly one
  `ST-` reference and null executor/project/name/request/content fields.
- Cover missing, malformed, raw UUID, gateway ID, PID, name, `停止所有`, mixed
  project work, invented skill, and prompt-injection-shaped requests.
- Add `stop_agent_session` to the static schema and registry descriptors.
- Make resolver validation skill-specific: the list skill remains argument-free;
  the stop skill requires `^ST-[0-9A-F]{32}$` and forbids every other field.
- Return a bounded clarification for invalid or mixed stop requests without
  looking up sessions or invoking a handler.

Verification:

```powershell
node --test test/gateway.test.mjs
```

Commit checkpoint: `feat: register precise session stop skill`

## 2. Preserve Exact Native Control Identity

Files:

- Modify `src/active-agent-codex-worker.mjs`.
- Modify `src/active-agent-sessions.mjs`.
- Modify `test/active-agent-sessions.test.mjs`.

Work:

- First add fixture tests proving Codex list rows retain the exact latest
  `turnId` without exposing prompt or item content.
- Add an exact worker query mode keyed by `thread_id`; it must bypass the
  200-row display limit, validate the highest database generation/schema, and
  return the exact latest turn status and ID.
- Split collection from formatting so callers can receive frozen structured
  aggregate records, truncation metadata, and bounded warnings.
- Retain Claude `sourcePath`, `sessionId`, PID, and `procStart` only as internal
  control metadata. Add an exact registry reread that canonicalizes the file
  beneath `~/.claude/sessions`, enforces size/type limits, and rejects changed
  identity or terminal state.
- Add uncapped scheduler-owner input to aggregation and detect hidden duplicate
  gateway owners before a row can become stoppable.

Verification:

```powershell
node --test test/active-agent-sessions.test.mjs
```

Commit checkpoint: `refactor: expose exact active session identities`

## 3. Add Crash-Safe Stop Persistence

Files:

- Modify `src/store.mjs`.
- Add `test/stop-agent-store.test.mjs`.

Work:

- Add migrations for `agent_stop_targets`, `agent_stop_operations`,
  `agent_stop_ref_claims`, `agent_stop_requests`, their indexes, and one
  singleton gateway-instance owner row.
- Store typed provider proofs and canonical JSON for sorted gateway task IDs;
  do not store prompts, message bodies, command lines, environment values, or
  token contents.
- Implement 128-bit `ST-` generation, ten-minute/500-target cleanup, and
  30-day/5,000-operation cleanup that never removes nonterminal operations or
  their claims.
- Implement the immutable `provider_target_key` and nullable unique
  `active_operation_key`. Atomically release only the active key for terminal
  pre-signal outcomes that prove no side effect occurred.
- Implement one transaction for target validation, operation generation claim,
  reference claim, request mapping, and owner epoch/token compare-and-swap.
- Implement atomic terminal outcome plus outbox rows for all current requests;
  claiming an already-terminal operation must create its reply in that same
  transaction.
- Add request queries for missing outbox rows and recovery queries for all
  `pending`/`signaling` operations.
- Implement singleton owner snapshot/replace transactions with PID,
  `procStart`, epoch, `running`/`draining` state, and atomic reassignment of
  stranded operations to fresh recovery tokens.

Tests:

- Migration idempotency and schema constraints.
- Reference expiry, cleanup bounds, and raw content exclusion.
- Same reference/different messages and different references/same target under
  concurrent claims.
- Fresh-reference retry after a no-signal terminal failure.
- Terminal result/outbox atomicity and missing-outbox repair.
- Owner token CAS failures, stale epoch takeover, live/inaccessible owner
  rejection, and tombstone preservation.

Verification:

```powershell
node --test test/stop-agent-store.test.mjs
```

Commit checkpoint: `feat: persist precise stop operations`

## 4. Implement Fenced Gateway Cancellation

Files:

- Modify `src/scheduler.mjs`.
- Modify `src/store.mjs` only for bounded task-status lookup if needed.
- Add `test/scheduler-stop.test.mjs`.

Work:

- Add an uncapped exact activity lookup returning the full sorted task set for
  one gateway Session.
- Add per-session fence generations. `enqueue()` must reject a fenced Session
  before creating or announcing any continuation.
- Implement `prepareCancel(gatewayId, expectedTaskIds)` as a synchronous
  validate-and-fence operation with no cancellation side effects.
- Implement `commitCancel(plan)` to affect only tasks named by the validated
  plan: remove queued tasks, reject their approval waiters, and abort the exact
  active task. Add `releaseCancel(plan)` for failed pre-signal commits.
- Keep the existing user-facing `cancel` action behavior intact by adapting it
  through a separate compatibility path; do not let it weaken the internal
  skill's exact-set contract.
- Add recovery classification for all-cancelled, wholly-active/queued,
  all-naturally-finished, added/replaced, and partial/mixed task states.

Verification:

```powershell
node --test test/scheduler-stop.test.mjs test/gateway.test.mjs
```

Commit checkpoint: `feat: add fenced gateway session cancellation`

## 5. Add Identity-Safe Windows Process Termination

Files:

- Modify `scripts/session-probe.ps1`.
- Modify `src/active-agent-sessions.mjs` or add a focused Node adapter module.
- Add `test/claude-session-stop.test.mjs`.

Work:

- Extend the fixed JSON protocol with one exact terminate operation. Reject
  extra fields, oversized input, invalid PID, and invalid FILETIME before any
  Win32 call.
- Open one process handle with query, synchronize, and terminate rights.
  Through that retained handle, verify `STILL_ACTIVE` and exact creation
  FILETIME, call `TerminateProcess`, and wait at most five seconds.
- Terminate only the root process. Do not call `taskkill`, enumerate by name,
  reopen by PID, or terminate descendants.
- Return bounded states for terminated, already exited, reused identity,
  access denied, timeout, and helper error. Map `already_exited` to audited
  `already_finished`.
- Keep stdout/stderr and helper timeouts bounded in the Node adapter.

Verification:

```powershell
node --test test/claude-session-stop.test.mjs test/active-agent-sessions.test.mjs
```

Use only disposable child processes created by the test.

Commit checkpoint: `feat: stop exact claude process instances`

## 6. Validate Codex Control Configuration

Files:

- Modify `src/config.mjs`.
- Modify `config/gateway.json` only if a real endpoint is available; otherwise
  leave `codexControl` absent.
- Add `test/codex-control-config.test.mjs`.

Work:

- Parse optional `gateway.codexControl` with at most four unique endpoints.
- Clamp connection/request timeouts and frame sizes to the design bounds.
- Canonicalize proxy socket paths beneath
  `~/.codex/app-server-control`; reject reparse entries and paths outside it.
- Accept WebSocket URLs only with literal `127.0.0.1` or `[::1]`, explicit
  port, `ws:`, and no user info, query, or fragment.
- Canonicalize a regular non-reparse token file no larger than 4 KiB beneath
  `%LOCALAPPDATA%\lark-claude\secrets`. Never return or log its contents.

Verification:

```powershell
node --test test/codex-control-config.test.mjs
```

Commit checkpoint: `feat: validate local codex control endpoints`

## 7. Implement the Bounded Codex Control Client

Files:

- Add `src/codex-control-client.mjs`.
- Add `test/codex-control-client.test.mjs`.

Work:

- Build an injected transport boundary for proxy stdio and authenticated
  loopback WebSocket connections. Endpoint values must come only from validated
  configuration.
- Resolve the configured Codex executable and invoke proxy transport with fixed
  `app-server proxy --sock <path>` arguments.
- Implement bounded JSON-RPC framing, unique request IDs, initialization,
  response correlation, frame caps, deadlines, and deterministic cleanup.
- Probe `thread/loaded/list` plus `thread/read` and require exactly one endpoint
  to own the exact `threadId`/`turnId` in `inProgress` state.
- Implement `turn/interrupt { threadId, turnId }`, require accepted `{}`, then
  poll only that turn until `interrupted` or the five-second deadline.
- Map zero/multiple owners, authentication, incompatibility, natural
  completion, timeout, and protocol errors to bounded reason codes. Never
  terminate an app-server or Desktop process.

Verification:

```powershell
node --test test/codex-control-client.test.mjs
```

Commit checkpoint: `feat: interrupt exact codex turns`

## 8. Mint Stop References Only After Exact Ownership Proof

Files:

- Modify `src/active-agent-sessions.mjs`.
- Modify `src/internal-skills.mjs`.
- Modify `src/gateway.mjs` only to inject narrow dependencies.
- Modify `test/active-agent-sessions.test.mjs`.
- Add `test/stop-targets.test.mjs`.

Work:

- For every displayed candidate, perform the uncapped exact-owner lookup before
  minting. Suppress references for ambiguous, incomplete, truncated, timed-out,
  or unreachable control ownership.
- Apply gateway precedence only after proving exactly one gateway owner; bind
  its complete sorted task set. Bind exact endpoint/thread/turn for Codex and
  exact registry/session/PID/FILETIME for Claude.
- Store the target through a narrow Store method and format only
  `停止ID: ST-<32 hex>` or a bounded `停止: 不可用 (<reason>)` suffix.
- Keep display row and message-length caps unchanged. Do not expose hidden
  identifiers in the response.

Verification:

```powershell
node --test test/active-agent-sessions.test.mjs test/stop-targets.test.mjs
```

Commit checkpoint: `feat: issue verified session stop references`

## 9. Implement the Stop Operation State Machine

Files:

- Add `src/stop-agent-session.mjs`.
- Modify `src/internal-skills.mjs`.
- Add `test/stop-agent-session.test.mjs`.

Work:

- Accept only `{ sessionRef, messageId }` plus injected Store and the three
  provider adapters. Do not pass raw message text, shell access, or unrestricted
  paths into the handler.
- Resolve and atomically claim the reference/target generation/request. Repeat
  the uncapped exact-owner validation before any provider side effect.
- For Gateway, call `prepareCancel`, commit `signaling` with the exact task set,
  then call `commitCancel`. Release the plan if the database commit fails.
- For Claude and Codex, commit `signaling` immediately before the exact retained
  handle termination or `turn/interrupt` request.
- Verify provider-specific completion and atomically terminalize the operation
  plus all mapped outbox replies.
- Enforce epoch/token CAS on every state transition. Bound contenders to ten
  seconds and return `stop_in_progress` without a second signal.
- Release active-operation uniqueness only for terminal outcomes that prove no
  signal occurred. Preserve same-reference determinism.
- Format only the fixed public outcomes in the design; log bounded IDs and
  categories without secrets or conversation content.

Tests:

- Success and every defined public outcome for all three adapters.
- Same-ref/different-message and different-ref/same-target races.
- Crashes before `signaling`, after `signaling`, and after provider completion.
- Adapter exceptions before and after signaling, attempt limits, contender
  timeout, and fresh-reference recovery.
- Proof that no broader provider fallback is invoked.

Verification:

```powershell
node --test test/stop-agent-session.test.mjs test/stop-agent-store.test.mjs
```

Commit checkpoint: `feat: execute idempotent session stop operations`

## 10. Wire Startup Recovery, Shutdown, and Gateway Dispatch

Files:

- Modify `src/gateway.mjs`.
- Modify `src/store.mjs`.
- Modify `test/gateway.test.mjs`.
- Add `test/stop-recovery.test.mjs`.

Work:

- Replace the PID-only startup guard with the exact singleton owner protocol.
  Probe the recorded PID/FILETIME, recheck the unchanged owner snapshot inside
  an immediate transaction, then atomically install the new epoch and recovery
  tokens.
- Reconcile every `pending` and `signaling` operation before accepting Lark
  events. Use the persisted target proof only; never capture a replacement PID,
  turn, task set, or endpoint.
- Repair every request mapping missing an outbox row regardless of operation
  state, then flush through the existing outbox sender.
- Dispatch the list skill with the narrow minting dependencies and the stop
  skill with `sessionRef` plus inbound message ID. Neither path may create a
  project Session or task.
- On graceful shutdown, mark the owner `draining`, stop intake, release owned
  pre-signal attempts, verify owned signaling attempts within a deadline, and
  retain the PID/FILETIME tombstone until a later startup proves process death.
- Keep health and log output bounded and include recovery counts, never target
  secrets.

Verification:

```powershell
node --test test/gateway.test.mjs test/stop-recovery.test.mjs
```

Commit checkpoint: `feat: recover session stops across gateway restarts`

## 11. Add the Real Codex Compatibility Test

Files:

- Add `test/codex-control-integration.test.mjs`.
- Add a bounded test helper only if needed under `test/fixtures/`.

Work:

- Skip with a clear reason when no configured reachable control transport is
  available.
- Start one disposable long-running turn on app-server client A.
- Connect client B to that same server, prove exact ownership through
  `thread/loaded/list` and `thread/read`, interrupt the exact turn, and observe
  `status: interrupted`.
- Confirm an unrelated turn remains active and no Codex/Desktop process was
  terminated.
- Cache only a bounded compatibility result for the installed executable
  identity/version; a failed test disables native Codex stop with
  `control_incompatible`.

Verification:

```powershell
node --test test/codex-control-integration.test.mjs
```

Commit checkpoint: `test: verify cross-client codex interruption`

## 12. Documentation, Full Verification, and Rollout

Files:

- Modify `README.md`.
- Modify help text in `src/gateway.mjs`.
- Add or update operational notes under `docs/` if the service restart command
  or endpoint provisioning requires them.

Work:

- Document the allowlisted query/stop flow, ten-minute `停止ID`, exact-stop
  syntax, fixed failure meanings, and why current stdio-only Codex Desktop rows
  show `control_unreachable`.
- Document validated Codex endpoint/token-file prerequisites without including
  credentials.
- Run static diff checks and the full Node suite.
- Run the real Windows helper tests and a disposable Claude child-process stop.
- Run the two-client Codex compatibility test only against a disposable turn.
- Restart the Gateway. Verify health, startup recovery, logs, and outbox.
- From Feishu, query active sessions and stop one dedicated disposable Gateway
  or Claude Session using its displayed `停止ID`. Confirm the exact target
  stops, unrelated Sessions remain active, a repeated request is idempotent,
  and no project Session/task was created for either internal skill.

Verification:

```powershell
npm test
git diff --check
```

Final commit checkpoint: `docs: document precise agent session stopping`

## Rollback

- Disable native provider adapters independently and report bounded unavailable
  capabilities; never replace them with process-wide fallback behavior.
- Removing the `stop_agent_session` registry/schema entry disables new stop
  requests without changing normal project task handling.
- Leave additive stop/audit tables in place during rollback so unfinished or
  uncertain operations remain attributable. Do not delete audit state as part
  of a code rollback.
