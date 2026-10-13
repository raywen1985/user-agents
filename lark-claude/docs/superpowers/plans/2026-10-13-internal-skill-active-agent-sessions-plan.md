# Internal Skill and Active Agent Sessions Implementation Plan

Date: 2026-10-13
Design: `../specs/2026-10-13-internal-skill-active-agent-sessions-design.md`

## 1. Lock the routing contract with tests

- Extend resolver test fixtures with every schema field.
- Add failing tests for a valid argument-free `internal_skill` intent, invented
  skills, non-null arguments, mixed project/internal work, reply context, and
  prompt-injection-shaped content.
- Add `internal_skill` and `skill_name` to the schema and router prompt.
- Implement deterministic resolver validation against a supplied registry.

## 2. Add the static internal-skill registry

- Add a registry with the single `list_active_agent_sessions` descriptor.
- Expose router-safe descriptors, `has`, and bounded dispatch operations.
- Add tests proving unknown names and message-derived arguments cannot reach a
  handler.

## 3. Expose live gateway activity

- Add scheduler tests for queued, running, waiting-approval, duplicate-session,
  and bounded snapshot behavior.
- Add session/task IDs to approval waiters and implement the immutable scheduler
  reference snapshot.
- Add a bounded store lookup for the referenced task/session display fields.
- Build and freeze the enriched gateway snapshot before internal-skill dispatch.

## 4. Implement normalization, deduplication, and formatting

- Add fixture-driven tests for provider records, status/field precedence,
  `(agent, nativeId)` keys, invalid IDs, duplicate native records, duplicate
  gateway mappings, deterministic sorting, caps, sanitization, and truncation.
- Implement provider-independent normalization and formatting in
  `src/active-agent-sessions.mjs`.

## 5. Implement the Codex collector Worker

- Add temporary SQLite fixture tests for numeric generation selection,
  incompatible highest generation, WAL visibility, required schema validation,
  latest-turn ordering, safe metadata columns, missing metadata, row 201, and a
  terminated slow Worker.
- Add `src/active-agent-codex-worker.mjs` for synchronous read-only SQLite work.
- Add the parent Worker adapter with a four-second termination deadline and
  structured result validation.

## 6. Implement the Claude registry collector

- Add temporary-file tests for deterministic enumeration, file/size/result
  caps, malformed rows, terminal/idle statuses, unknown live statuses, and
  duplicate session IDs.
- Implement async bounded reads from the fixed `~/.claude/sessions` directory
  and produce validated process probes.

## 7. Implement and integration-test the Windows probe

- Add `scripts/session-probe.ps1` with fixed JSON input/output, FileShare.None
  lock checks, and Win32 process creation/exit probes.
- Add Windows-only integration tests for free and held files, live process and
  exact FILETIME, wrong FILETIME, nonexistent PID/error 87, exit races, and a
  terminated process object retained by an external handle.
- Add the Node adapter with fixed PowerShell path, input/result validation,
  stdout/stderr limits, process-tree termination, and a three-second timeout.

## 8. Orchestrate provider deadlines and partial failures

- Add tests for each provider failing independently, all providers failing,
  total deadline cancellation, completed-result preservation, and diagnostic
  bounds.
- Orchestrate gateway, Codex, Claude, and the shared native probe under the
  five-second skill deadline.

## 9. Wire the gateway and documentation

- Inject registry descriptors into router context.
- Handle the resolved internal skill through the existing global outbox
  deduplication path without creating a project session/task.
- Update help text and `README.md` with the allowlist boundary and example query.

## 10. Verify and roll out

- Run `npm test` in `lark-claude` and targeted Windows helper tests.
- Run the active-session collector read-only against this PC and compare it
  with current Codex/Claude/gateway activity.
- Check formatting and absence of prompt/conversation content.
- Restart `LarkClaudeGateway`, verify health/logs, and send a Feishu active-agent
  query. Confirm the reply does not create a gateway project session.
- Commit implementation and verification changes without including unrelated
  working-tree files.
