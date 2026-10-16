# Auto-Discovered Agent Projects Implementation Plan

Date: 2026-10-16
Design: `../specs/2026-10-16-auto-discovered-agent-projects-design.md`
Status: Ready for implementation

## Delivery Rules

- Preserve every existing dirty-worktree change and commit only the plan
  document separately.
- Treat native Claude/Codex metadata and explicit local overrides as the only
  project authority sources. Gateway database paths never authorize access by
  themselves.
- Never accept a Lark-provided filesystem path as a project root.
- Fail closed on incomplete discovery, stale authority, exclusions, reparse
  points, identity conflicts, or overlapping running project roots.
- Keep Claude's current tool restriction unchanged.

## 1. Convert Project Configuration to Optional Policy

Files:

- Modify `src/config.mjs`.
- Modify `config/projects.json` only if the new optional fields are needed.
- Modify `prompts/route.md` and `schemas/intent.schema.json`.
- Modify `test/gateway.test.mjs` and focused config tests.

Work:

- Accept empty/missing project overrides and canonical excluded roots.
- Keep existing entries as trusted exact-path alias overrides, not discovery
  eligibility.
- Replace router default-project behavior with a bounded project query that is
  resolved only against discovered metadata.
- Reject path-shaped and unsafe project queries.

Verification: `node --test test/gateway.test.mjs`

## 2. Build Bounded Global Native Discovery

Files:

- Refactor `src/claude-session-history.mjs`.
- Refactor `src/session-catalog.mjs`.
- Extend `src/active-agent-codex-worker.mjs` if exact project evidence requires
  additional bounded metadata.
- Extend `test/session-catalog.test.mjs`.

Work:

- Enumerate all safe Claude project-history directories, derive canonical cwd
  only from transcript envelopes, and retain exact evidence locators.
- Keep untitled native Claude sessions out of fuzzy name matching while allowing
  mapped Gateway sessions to revalidate against exact transcript ID/cwd.
- Preserve every safe Codex cwd rather than filtering it through overrides.
- Build canonical project records with aliases, collision-safe display labels,
  exclusions, source evidence, and provider completeness.
- Replace silent 200-row Gateway truncation with a 20,000-plus-sentinel bound.

Verification: `node --test test/session-catalog.test.mjs`

## 3. Persist and Revalidate Project Authority

Files:

- Modify `src/store.mjs`.
- Add a focused project-authority helper module if it keeps boundaries small.
- Extend `test/session-lookup-store.test.mjs`.

Work:

- Add additive project-authority and project-candidate-set tables.
- Store only native-evidence or explicit-override revalidation recipes.
- Backfill existing sessions only when current trusted evidence proves their
  canonical path.
- Make project selection single-use, reply-bound, expiring, and transactional.
- Keep Gateway-only database rows non-authoritative.

Verification: `node --test test/session-lookup-store.test.mjs`

## 4. Wire Lookup, Selection, Guards, and Scheduling

Files:

- Modify `src/resolver.mjs`.
- Modify `src/session-lookup-service.mjs`.
- Modify `src/gateway.mjs`.
- Modify `src/scheduler.mjs`.
- Modify `src/executors/claude.mjs` and `src/executors/codex.mjs`.
- Modify `src/read-approval-policy.mjs`.
- Extend lookup, guard, scheduler, and approval tests.

Work:

- Search all relevant native projects before fuzzy selection and require the
  applicable completeness set.
- Resolve project queries after discovery and provide durable numbered project
  selection for explicit new/no-match flows.
- Retry one stale unique lookup without ever falling through to creation.
- Revalidate canonical path, exclusions, and authority immediately before every
  worker start, including native-less sessions.
- Treat equal and ancestor/descendant roots as scheduler conflicts.
- Repeat protected analyzer/host/profile containment checks for dynamic roots.

Verification: `node --test test/session-lookup-service.test.mjs test/executor-resume-guard.test.mjs test/scheduler-stop.test.mjs test/read-approval-policy.test.mjs`

## 5. Documentation, Full Verification, and Rollout

Files:

- Modify `README.md`.
- Update the design status after implementation verification.

Work:

- Document automatic discovery, optional overrides/exclusions, project
  selection, and the continuing Claude Bash limitation.
- Run focused tests, the complete Node suite, and `git diff --check`.
- Run a read-only local discovery smoke test proving the existing
  `D:\ulibs\client` / `导入设置优化` native session is selected.
- Restart `LarkClaudeGateway` and verify process/listener health.

Verification: `npm test`, `git diff --check`, Gateway health check

## Rollback

Restore mandatory override filtering in the router/catalog while leaving the
additive authority and project-selection tables in place. Existing sessions,
tasks, claims, native histories, and outbox rows require no data deletion.
