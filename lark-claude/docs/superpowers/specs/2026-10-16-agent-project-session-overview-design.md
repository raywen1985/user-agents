# Agent Project And Session Overview Design

Date: 2026-10-16
Status: Draft for specification review

## Problem

The gateway can report sessions that are actively doing work, and its session
catalog can discover resumable Claude Code and Codex history. It cannot yet
answer broader read-only questions such as:

- What Claude Code and Codex projects and sessions exist on this PC?
- What sessions belong to one project?
- Which project owns one named session, and is that session active or
  resumable?

The existing `list_active_agent_sessions` internal skill is intentionally
limited to active work. Expanding it to historical and idle records would make
its name and behavior misleading. The new capability therefore needs a
separate internal skill that reuses the same trusted local collectors without
changing the active-session contract.

## Goals

- Add one read-only internal skill named `inspect_agent_workspace`.
- Support three query scopes: all projects, one project, and one session.
- Cover Claude Code, Codex, and gateway-owned records in one normalized view.
- Answer metadata questions about counts, ownership, executor, state, native
  and gateway identifiers, recent activity, and resumability.
- Resolve project and session names conservatively and show candidates when a
  name is ambiguous.
- Return useful partial results when one local provider is unavailable.
- Preserve the privacy boundary that excludes conversation content.

## Non-Goals

- Reading prompts, responses, summaries, tool output, or other transcript
  content to answer what a session discussed.
- Starting, resuming, stopping, renaming, deleting, or otherwise modifying a
  project or session.
- Accepting a message-provided filesystem path as authority to inspect an
  arbitrary directory.
- Scanning the entire filesystem for repositories.
- Replacing `list_active_agent_sessions`, `stop_agent_session`, or the normal
  continue/create workflow.
- Inferring a match from recency when multiple projects or sessions have the
  same or similar name.

## Considered Approaches

### Extend `list_active_agent_sessions`

This would reduce registry changes but would broaden a deliberately narrow
skill. Existing users asking for active work could unexpectedly receive idle
history, project counts, and ambiguity prompts. This approach is rejected.

### Register separate project and session skills

Separate skills would have narrow contracts, but the routing and collection
logic would be duplicated. Natural questions often move between project and
session detail, so choosing between two skills would add user-visible friction.
This approach is rejected.

### Register one scoped overview skill

This is the selected approach. One internal skill accepts a scope plus optional
project and session queries. A shared snapshot is collected once and then
projected into the requested view.

## Intent Contract

The router schema adds `inspect_agent_workspace` to the static `skill_name`
allowlist and adds four nullable fields:

- `overview_scope`: `all`, `project`, or `session`;
- `overview_executor`: `claude`, `codex`, or null;
- `project_query`: a project alias, display name, or directory leaf name;
- `session_query`: a session name or complete native/gateway session ID.

The resolver enforces these combinations:

- `all`: both query fields are null;
- `project`: `project_query` is non-empty and `session_query` is null;
- `session`: `session_query` is non-empty and `project_query` is optional.

`overview_executor` is optional for every scope. When present, only that native
provider and matching gateway records participate in identity/name matching,
aggregation, and completeness decisions. When absent, both Claude Code and
Codex are relevant. This field is separate from the normal execution selector
so a read-only overview cannot accidentally become an execution request.

All unrelated internal-skill fields must be null. Invalid or incomplete
combinations resolve to clarification rather than being repaired with an
assumption. A request that mixes an overview query with create, continue, stop,
or project work also clarifies; the gateway must not silently drop either
intent.

For a mixed request, the router must emit `action=clarify`, set
`needs_clarification=true`, populate one bounded clarification question, and
leave `skill_name`, overview fields, project/executor/session selection fields,
and mutating-operation fields null. The resolver rejects any structurally mixed
combination that reaches it. Router contract tests must exercise representative
natural-language mixtures such as `查看会话 X 然后停止它` and verify the
clarification output; resolver-only tests are not sufficient to prove this
behavior.

Representative natural-language requests include:

- `查看本机 Claude Code 和 Codex 项目、会话概况`
- `client 项目有哪些会话`
- `导入设置优化这个会话属于哪个项目`
- `会话 fb0f2ece-ee8e-46fb-a7e4-84d1c662a62a 还能恢复吗`

The router extracts names only. It does not choose filesystem paths, open data
stores, or decide that a fuzzy candidate is unique.

## Internal Skill Registration

`src/internal-skills.mjs` statically registers `inspect_agent_workspace` with a
read-only description. The gateway injects a dedicated handler. No directories
are scanned for executable skills and no message-derived name can select an
unregistered handler.

The handler receives only:

- the validated scope and query strings;
- the validated optional overview executor filter;
- a bounded, enriched gateway activity snapshot;
- configured project metadata and exclusion policy;
- explicit collector adapters for the fixed Claude Code and Codex data roots;
- explicit per-source completeness, cap, and activity-probe status;
- immutable timing and output limits.

It does not receive a shell, executor, unrestricted message payload, or a
generic filesystem operation.

## Snapshot Model

The overview module builds on the session catalog introduced for native session
lookup. The catalog is responsible for discovering and normalizing records;
the overview module is responsible for read-only aggregation, matching, and
formatting.

Each normalized session record contains only allowlisted metadata:

- executor: `claude` or `codex`;
- provider sources: gateway, Claude Code, and/or Codex;
- display name and safe aliases;
- verified canonical project path and display label;
- ownership completeness and a bounded ownership diagnostic;
- native session ID and optional gateway session ID;
- latest metadata timestamp;
- activity: `waiting_approval`, `running`, `queued`, `idle`, or `unknown`;
- resume capability: `resumable`, `busy`, or `unavailable`;
- bounded provider diagnostic category when metadata is incomplete.

Conversation titles explicitly persisted by the native client or gateway are
metadata and may be displayed. The collectors must not derive a title from
conversation bodies, first-user messages, summaries, previews, rollout items,
or tool output.

Projects are aggregated by canonical, case-insensitive Windows path. A project
record contains its preferred alias or deterministic display label, canonical
path, contributing providers, newest activity timestamp, session counts by
executor, plus separate activity-state and resume-capability counts.

The implementation must align with the auto-discovered-project design. Native
history metadata may establish a verified project, configured aliases may
improve display and matching, and configured exclusions always win. A
message-provided absolute path is treated only as an opaque query string and
must never authorize inspection outside fixed native roots.

## Completeness

Completeness is tracked independently for gateway session enumeration, gateway
activity enumeration, Claude history, Claude live-owner probes, Codex history,
and Codex writer-lock/turn probes. It is never inferred from an empty result.
Each stage reports whether it completed, hit an input cap, timed out, skipped
unsafe data, or failed compatibility validation.

Identity completeness and project-ownership completeness are also separate. A
complete gateway enumeration can prove that an exact gateway ID names a stored
row, but the row's stored `project_path` is display metadata rather than fresh
ownership authority. Ownership is complete only when current native metadata
corroborates the same canonical path or when the gateway row references a
currently valid explicitly configured project with no conflicting native
identity. A gateway-only or uncorroborated row remains identifiable with
`owner=unavailable`; its stored path is not returned as verified ownership.

The overview aggregates and matches over the complete bounded provider
snapshot defined by the native-discovery design. It must not take an arbitrary
first 200 records before computing totals, ownership, or uniqueness. Claude and
Codex retain their existing provider scan bounds, which can include up to
20,000 candidate records per provider; gateway enumeration uses the existing
bounded store contract. Only formatted display rows are capped at 30.

Hitting any provider or gateway enumeration cap marks that source incomplete.
The implementation may retain a smaller in-memory representation only if it
preserves exact aggregate counts and a complete search index for project keys,
names, aliases, and full IDs. Otherwise it must treat the omitted set as
unknown and must not claim complete totals, no-match, ownership, or uniqueness.

Scope completeness is evaluated as follows:

- an all-project overview is complete when gateway enumeration and every native
  source selected by `overview_executor` completed; when the filter is null,
  both Claude and Codex must complete; activity and resume counts carry their
  own probe-completeness markers;
- project or session name matching requires every native source selected by
  `overview_executor`, or both native sources when it is null, plus gateway
  enumeration to have complete history/name data before a result can be called
  unique;
- a fuzzy match is never selected while a relevant name source is incomplete;
- an exact gateway ID is identity-complete when gateway enumeration is complete,
  but its ownership follows the independent corroboration rule above;
- an exact native ID with `overview_executor` requires the selected native
  identity source to be complete; without that filter, both native identity
  sources must be complete so a cross-provider ID collision cannot be hidden;
  incomplete activity probes may still make state and resumability unknown;
- a project filter narrows relevant records only after the project itself is
  resolved under the same completeness rules.

When identity completeness is unavailable, the skill may display bounded
observed candidates, but labels them provisional and does not call any one of
them the unique owner or match.

Sessions whose identity is known but ownership is unavailable remain in global
session totals and exact-ID results. They do not contribute to a verified
project's session count, project-scoped matching, or project totals. Global
output reports them separately as `unassigned ownership` so project counts can
be reconciled with the total session count without inventing a project.

## Activity And Resumability

The overview reports activity and resumability as two orthogonal concepts:

- `waiting_approval`, `running`, and `queued` come from the current gateway or
  validated native activity snapshot;
- `idle` means all activity evidence relevant to that record completed and no
  active owner was found;
- `unknown` means an activity snapshot, live-owner probe, writer-lock probe, or
  turn-state probe needed for that record was incomplete;
- `resumable` means current native metadata and project ownership pass the
  existing resume guards and no active owner is present;
- `busy` means a live owner, held writer lock, in-progress turn, or current
  gateway task prevents a safe resume;
- `unavailable` means the snapshot is incomplete or identity/project metadata
  does not satisfy the existing safety checks.

Every session has exactly one activity value and exactly one resume-capability
value. Counts are reported in two separately labeled groups, and each group's
values sum to the total session count. `activity=unknown` always implies
`resumeCapability=unavailable`; `resumeCapability=busy` requires verified
active/busy evidence and cannot be inferred from a failed probe. Gateway
activity truncation makes unmatched gateway activity `unknown`, not `idle`.

The overview does not perform final execution-time revalidation because it
cannot execute. Its result is informational and may become stale immediately.
Any later resume request still uses the existing strict revalidation path.

## Matching

Project matching considers configured aliases, deterministic display labels,
and directory leaf names. Session matching considers explicit names, safe
aliases, complete native IDs, and complete gateway IDs. IDs use exact
case-insensitive equality. Names use the existing normalized session-name
matcher where possible.

Matching follows these rules:

1. An exact ID wins within the requested scope.
2. A unique exact normalized name wins over fuzzy matches.
3. A unique fuzzy match may be selected only when it satisfies the existing
   confidence and separation rules.
4. Multiple plausible matches return a bounded candidate list.
5. Recency sorts candidates for display but never breaks an identity tie.

The rules above apply only after the scope-completeness checks. Under an
incomplete relevant source, exact names and fuzzy names are reported as
observed candidates rather than authoritative unique matches. Exact IDs follow
the narrower identity-completeness rules in the Completeness section.

An optional project query on session scope narrows the candidate set before
session matching. A project name that matches several canonical paths remains
ambiguous; the skill returns projects with enough path context to distinguish
them.

## Output

### All-project overview

The response contains:

- total discovered projects and sessions;
- Claude Code and Codex session counts;
- separately labeled activity counts and resume-capability counts;
- the count of identified sessions whose project ownership is unavailable;
- the newest known activity time;
- a project list ordered by active state, newest activity, display label, and
  canonical path.

Each project line shows its label, abbreviated safe path, executor counts,
active count, total session count, and newest activity. Partial totals are
explicitly labeled `observed` and name the incomplete sources. The list is
bounded and ends with an explicit omitted-count marker when truncated.

### One-project overview

The response contains:

- preferred label and canonical path;
- contributing providers;
- counts by executor plus separate activity and resume-capability groups;
- newest activity time;
- a bounded session list ordered by active state, newest activity, executor,
  name, and stable ID.

Each session line shows executor, name, state, resumability, newest activity,
and a shortened display ID. Full IDs remain available through an exact session
query.

### One-session detail

The response contains:

- name, executor, and provider sources;
- owning project label and canonical path;
- activity state and resumability;
- native and gateway IDs when present;
- newest metadata time;
- a concise diagnostic when capability is unavailable.

The response explicitly states that it is based on metadata only. It must not
claim what work was performed in the session.

When identity is complete but ownership is not, the session response replaces
the project label/path with `ownership unavailable` and a bounded reason. It
does not expose the gateway row's uncorroborated stored path as authoritative.

### Bounds

The skill aggregates and matches over every record in the completed bounded
provider snapshots. It displays at most 30 project or session rows, emits at
most three bounded provider warnings, and limits the final message to 12,000
characters. It uses the existing sanitization helpers for control characters,
names, and paths. Display truncation is deterministic and always disclosed; it
does not change totals or matching.

## Partial Failure And No-Match Behavior

Claude Code, Codex, and gateway sources are collected independently with the
existing provider deadlines and one overall deadline. A provider failure does
not erase successful results. The response appends a concise warning naming the
unavailable provider and category without raw exception details.

If every requested provider fails, the skill returns a query failure rather
than an empty overview. If a provider is incomplete, a no-match response says
that no match was found in the completed portion and identifies the incomplete
source. It must not present the result as proof that the project or session does
not exist.

The same rule applies to positive name matches: incomplete relevant sources
prevent an authoritative uniqueness claim. The response shows observed
candidates and identifies which source could contain additional conflicts. An
exact ID may still establish identity only under the completeness rules above;
its activity or resumability remains unknown when the corresponding probes are
incomplete.

Malformed individual metadata records are skipped and counted. Unsafe paths,
reparse points, incompatible database generations, timeouts, input caps, and
identity conflicts use the existing bounded diagnostic categories.

The skill never creates a session after a no-match and never offers an action
that bypasses the normal create/continue resolver.

## Privacy And Security

- All operations are read-only.
- Only the statically registered skill can reach the handler.
- Local sources are fixed per-user Claude Code, Codex, and gateway stores.
- SQLite files are opened read-only with query-only mode where applicable.
- Transcript reads are limited to the metadata envelope required to verify
  session ID and `cwd`; no conversation record is retained or formatted.
- Codex conversational columns such as title preview, first user message, and
  rollout content are not selected.
- Output excludes prompts, responses, summaries, tool output, environment
  variables, command lines, tokens, and credentials.
- The handler cannot execute, resume, stop, rename, or delete a session.
- Existing sender allowlisting and Lark outbox deduplication remain unchanged.

## Components

- `schemas/intent.schema.json`: register the skill and scoped query fields.
- `prompts/route.md`: describe supported overview questions and strict routing
  combinations.
- `src/resolver.mjs`: validate scope/query invariants and mixed-intent behavior.
- `src/internal-skills.mjs`: statically register the new skill.
- `src/agent-workspace-overview.mjs`: collect the catalog snapshot, aggregate
  projects, match queries, compute state/capability counts, and format replies.
- `src/session-catalog.mjs`: expose the bounded normalized metadata required by
  the overview without adding conversation fields.
- `src/gateway.mjs`: inject the handler and immutable dependencies.
- `test/agent-workspace-overview.test.mjs`: cover aggregation, matching,
  formatting, privacy, and partial failures.
- `test/gateway.test.mjs`: cover schema, resolver, registry, and dispatch.
- `README.md`: document natural-language examples and the metadata-only
  boundary.

## Testing

Automated coverage must prove:

- an all-project query summarizes Claude Code, Codex, and gateway records;
- one-project queries match aliases and directory leaf names;
- executor-qualified overview, project, name, and exact-ID queries use only the
  selected provider plus matching gateway rows; unqualified queries require
  both native sources for uniqueness;
- duplicate project labels return candidates rather than selecting by recency;
- one-session queries match exact native and gateway IDs;
- exact normalized names win over fuzzy matches;
- ambiguous session names return bounded candidates with project and executor;
- an optional project query narrows session matching before name resolution;
- activity and resumability are represented independently;
- duplicate gateway/native records are counted once;
- records beyond position 200 still contribute to totals, exact-ID matching,
  ownership, and duplicate-name ambiguity;
- excluded or unverified projects never become inspectable execution roots;
- one provider failure preserves other results and emits a bounded warning;
- all-provider failure is not formatted as an empty successful overview;
- incomplete scans qualify no-match results;
- incomplete relevant sources make exact-name and fuzzy-name matches
  provisional rather than unique, while exact IDs follow the documented
  identity-completeness matrix;
- an exact gateway ID remains identifiable when its native source is
  unavailable, but reports `ownership unavailable`; gateway-only rows and
  gateway/native path conflicts never expose an unverified owner;
- sessions with unavailable ownership remain in global session totals, are
  excluded from verified project totals, and appear in the separate
  unassigned-ownership count;
- owner-probe failure and gateway activity truncation produce
  `activity=unknown` and `resumeCapability=unavailable`, never `idle`;
- activity counts and resume-capability counts each sum independently to the
  total session count;
- project, session, warning, and total-message limits produce deterministic
  truncation markers;
- the overview never selects or formats conversation-body fields;
- end-to-end router contract cases for overview plus stop/create/continue emit
  `action=clarify`, and structurally mixed resolver inputs invoke no handler;
- existing active-list, stop-session, continuation, approval, and CC Switch
  behavior remains unchanged.

Verification runs the complete Node test suite and `git diff --check`. A local
read-only smoke test exercises all three scopes against the current PC. A Lark
smoke test sends one all-project query, one known project query, and one exact
session-ID query. Success means each response uses metadata only, identifies
the correct project/session ownership, reports current activity separately from
resumability, and creates no gateway task or native session.

## Rollout And Recovery

The change requires a gateway restart and no database migration. Schema,
router instructions, registry registration, and handler ship together so the
router cannot intentionally select a missing skill.

If a native storage format changes, only that provider reports an incomplete
snapshot; the other providers and existing gateway workflows continue to
operate. Removing the new schema fields, registry entry, handler wiring,
overview module, tests, and documentation restores the prior behavior without
altering stored sessions.
