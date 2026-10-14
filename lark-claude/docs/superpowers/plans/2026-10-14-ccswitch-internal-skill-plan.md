# CC Switch Internal Skill Implementation Plan

Date: 2026-10-14
Design: `../specs/2026-10-14-ccswitch-internal-skill-design.md`
Status: Ready for implementation

## Delivery Rules

- Preserve the in-progress precise-session-stop changes in the working tree.
- Keep `ccswitch` read-only and reachable only through the static internal-skill
  registry and fixed intent enums.
- Never place raw SQLite errors, configuration objects, provider errors,
  internal IDs, request/session data, or message content in output, logs, or the
  Gateway outbox.
- Run SQLite only in a disposable worker with a fixed database root, bounded
  resources, and a parent deadline.
- Add no provider-switching, routing mutation, or arbitrary query capability.

## 1. Lock Routing and Resolver Contracts

Files:

- Modify `schemas/intent.schema.json`.
- Modify `prompts/route.md`.
- Modify `src/internal-skills.mjs`.
- Modify `src/resolver.mjs`.
- Modify `test/gateway.test.mjs`.

Work:

- Add `ccswitch`, its five read actions, the rejection-only mutation sentinel,
  and the four fixed usage periods to the structured intent schema.
- Add resolver tests for valid actions, default-to-today usage, all-null foreign
  fields, non-CC-Switch field isolation, mixed project work, invented actions,
  and fixed mutation rejection.
- Register one namespace and pass only action/period to its handler.

Verification: `node --test test/gateway.test.mjs`

## 2. Build the Bounded SQLite Worker Boundary

Files:

- Add `src/ccswitch-reader.mjs`.
- Add `src/ccswitch-worker.mjs`.
- Add `test/ccswitch-reader.test.mjs`.

Work:

- Implement fixed-root canonical/reparse/file/sidecar validation and resource
  limits.
- Open with native read-only plus query-only/defensive settings in one read
  transaction; revalidate identities after reading.
- Implement a closed worker protocol, stable public error codes, a three-second
  parent deadline, termination, and no propagation of worker errors/stacks.
- Cover missing/incompatible databases, timeout/event-loop responsiveness,
  WAL visibility with an active writer, malformed sidecars, and no stale-copy
  fallback.

Verification: `node --test test/ccswitch-reader.test.mjs`

## 3. Implement Read Models and Usage Aggregation

Files:

- Extend `src/ccswitch-worker.mjs`.
- Extend `test/ccswitch-reader.test.mjs`.

Work:

- Implement exact schema validation and domain projection for overview,
  providers, health, and routing status.
- Parse only Claude's exact base-URL path, emit only a validated origin, and
  apply the shared NFKC public-label projector.
- Implement Asia/Shanghai periods, date-level detail precedence, rollup
  fallback, observed-only coverage, semantic-separated input tokens, BigInt
  micro-USD cost and latency math, stable breakdowns, and row limits.
- Test corrupt values, duplicate/current/health cardinality, URL/label canaries,
  same-day overlap, mixed semantics, decimal rounding, and deterministic ties.

Verification: `node --test test/ccswitch-reader.test.mjs`

## 4. Format the Internal Skill Safely

Files:

- Add `src/ccswitch-skill.mjs`.
- Add `test/ccswitch-skill.test.mjs`.

Work:

- Format the five actions in Chinese with fixed public errors and
  action-specific numeric caps.
- Build record-aware output under 12,288 UTF-8 bytes with exact omission counts.
- Emit only allowlisted structured diagnostic fields.
- Prove secret canaries are absent from result text, diagnostics, thrown errors,
  and a simulated persisted outbox row.

Verification: `node --test test/ccswitch-skill.test.mjs`

## 5. Wire Gateway Dispatch and Documentation

Files:

- Modify `src/gateway.mjs`.
- Modify `README.md`.
- Extend `test/gateway.test.mjs`.

Work:

- Inject one reader-backed `ccswitch` handler and dispatch only resolved enums.
- Avoid session snapshots for this skill and create no project Session, task,
  approval, or coding-agent worker.
- Document supported phrases, periods, observed-only semantics, and read-only
  limitations.

Verification: `node --test test/gateway.test.mjs test/ccswitch-skill.test.mjs`

## 6. Full Verification and Rollout

- Run syntax checks, focused tests, the full Node suite, and `git diff --check`.
- Run a production read-only smoke query against the fixed CC Switch database
  without printing sensitive rows.
- Restart the Gateway safely and verify health/log output.
- Send read-only Feishu queries for overview, providers, health, routing status,
  and today's usage; confirm no project Session/task is created.
- Do not perform any provider or routing mutation during rollout.

## Rollback

Remove the `ccswitch` registry/schema entries and handler wiring. The feature
has no Gateway migration and performs no logical mutation of the CC Switch
database, so rollback requires no data repair.
