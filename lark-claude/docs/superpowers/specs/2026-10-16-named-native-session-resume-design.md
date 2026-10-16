# Named Native Session Resume and Create Design

Date: 2026-10-16
Status: Specification review approved; pending user review

## Problem

The Lark gateway can continue sessions that it created because its database
maps each `CX-*` or `CL-*` ID to a native Codex or Claude session ID. It can
also discover and precisely stop native sessions created outside the gateway,
but it cannot continue those sessions.

The desired remote workflow names a session, sometimes approximately, and
supplies more work. The gateway must first look for an existing gateway or
native session with that name. It resumes one safe, unambiguous match. It
creates a new session only when a complete query proves that no candidate
exists. This must work for both active metadata and recent historical sessions
without using conversation bodies for naming, matching, routing, or output.

## Goals

- Accept an exact or fuzzy session name as the normal remote target.
- Search gateway-managed, Codex Desktop, and Claude Code session metadata.
- Include recent historical sessions that still have resumable native state.
- Resume one unambiguous idle result while preserving its conversation context.
- Ask the user to select when multiple plausible results remain.
- Create a new session only after a successful search returns no candidate.
- Keep project registration, executor restrictions, approval behavior, and
  scheduler serialization intact.
- Never expose raw native session IDs in Lark.

## Non-Goals

- Using prompts, messages, summaries, previews, tool output, or transcript
  bodies to infer a session name or project association.
- Semantic matching such as treating unrelated concepts as synonyms.
- Resuming a session that has a live writer or an in-progress turn.
- Injecting work into an unreachable running Codex Desktop app-server or a
  live Claude Code process.
- Importing every native session into the gateway eagerly.
- Searching projects that are not registered in gateway configuration.
- Replacing the existing exact `ST-*` stop contract.

## Selected Approach

Add a normal project-work route named `continue_or_create`, not a
project-independent internal skill. A project task necessarily carries user
content and may create or resume a worker, so it must retain the normal
scheduler, project, approval, and executor controls.

The route contains the requested `session_name`, optional executor and project
filters, and the task content. The gateway builds a bounded metadata-only
catalog, matches the requested name, and chooses one of four outcomes:

1. One safe match: import or reuse its gateway mapping, then enqueue a
   continuation.
2. Several plausible matches: persist a short-lived candidate set and ask the
   user to select one.
3. One matching session is busy or otherwise not safely resumable: explain the
   state and do not create a duplicate.
4. A complete search has no plausible match: create a new session using the
   requested name, provided executor and project can be resolved.

Explicit `CX-*` / `CL-*` references and replies to gateway session messages
continue to use the existing `continue` action. An explicit force-new phrase
continues to use `new`; ordinary name-targeted work uses
`continue_or_create`. This preserves existing deterministic controls while
making the common name-based path reuse-first.

Force-new skips fuzzy reuse but does not bypass name ownership. If its
normalized name is already claimed in that executor/project scope, the gateway
asks for a distinct name instead of creating an intentional duplicate.

## Routing Contract

The intent schema adds `continue_or_create` to the action enum. The router uses
it when a message supplies a session name or approximate session name and a
coding task without an exact gateway ID or reply binding. For example, a
message equivalent to `codex unity resource leak, continue the first fix`
produces:

- `action=continue_or_create`;
- `executor=codex` when explicitly supplied;
- `project_alias=unity` when explicitly supplied;
- `session_name=resource leak`;
- `content=continue the first fix`.

The router only extracts fields. It never decides that a session exists and
never performs fuzzy matching. The resolver validates field combinations and
returns a lookup request. Native storage access remains outside the language
model.

Candidate-number replies bypass the router. Before invoking the model, the
gateway resolves `reply_to` against an outbound candidate-list binding. For an
unexpired binding it accepts only the entire trimmed message matching
`^(?:[1-9]|10)$`, converts it to the corresponding zero-based candidate index,
and dispatches the stored selection request. Any other content receives a
fixed prompt to reply with one displayed number and is not sent to the router.
An expired or already-consumed binding receives its fixed terminal response.
A bare number without such a reply binding follows ordinary routing and can
never select a candidate.

If executor or project is omitted, an exact reply binding or recent compatible
gateway context may provide it. Otherwise the catalog may infer the missing
field only from one selected existing match. When no match exists, the gateway
asks for every creation field it cannot resolve rather than guessing it.

## Metadata Catalog

The catalog has three providers and a shared normalized record:

- Gateway: non-archived rows from the gateway `sessions` table, including
  gateway ID, executor, registered project, name, native ID, status, and update
  time.
- Codex: `session_index.jsonl` supplies only `id`, `thread_name`, and
  `updated_at`; the newest valid entry for an ID wins. The existing read-only
  Codex worker joins the ID to the highest-generation state database for `cwd`
  and to the highest-generation `thread_history_*.sqlite` database for the
  exact latest-turn state. It does not read `title`, `preview`,
  `first_user_message`, rollout bodies, or item content.
- Claude: for each registered project, the collector computes that project's
  fixed Claude storage directory, enumerates top-level UUID transcript files,
  and reads the sibling `<session-id>/custom-title.json`. Because Claude's
  directory encoding is lossy, that directory alone is not project-ownership
  proof. A resumable historical candidate must also provide the exact original
  `cwd` and matching session ID in an allowlisted top-level envelope record
  within the transcript's bounded metadata prefix. The parser projects only
  `sessionId`, `cwd`, and timestamp and immediately discards all other parsed
  properties; no message, prompt, result, or tool field is retained, indexed,
  compared, logged, or returned. A titled transcript without that proof is
  still a visible name match with capability `project_unverified`, so it
  blocks implicit same-name creation but cannot be resumed. Active registry
  metadata may add liveness and status but cannot replace exact `cwd` proof.

Every candidate contains provider, executor, native ID, display name,
canonical registered project path and alias, update time, gateway mapping when
present, and a fixed capability/status code. Native IDs and source paths are
control metadata and never appear in Lark output.

Inputs and output are bounded and path-safe:

- All roots are fixed local roots or canonical registered project paths.
  Every source is checked with `lstat`, must be the expected regular-file or
  directory type, must not be a reparse point, and must remain canonically
  contained beneath its expected root.
- Codex `session_index.jsonl` is capped at 32 MiB, 20,000 lines, and 64 KiB per
  line. State queries return at most 20,000 metadata rows. Exceeding a cap makes
  the Codex search incomplete instead of silently omitting a possible match.
- Each Claude project enumeration uses `fs.opendir`, stops after 2,001
  top-level entries, and is incomplete above 2,000. It opens at most 2,000
  title sidecars, each capped at 4 KiB. A candidate transcript metadata prefix
  is capped at 256 KiB and 64 records; inability to find exact `cwd` within
  that prefix yields `project_unverified`, not guessed ownership.
- Each provider emits at most 200 plausible/display candidates after examining
  its complete bounded input. More than 200 plausible candidates makes the
  result ambiguous and incomplete; it can never become no-match.
- Provider aggregate read volume is capped at 64 MiB, each provider has a
  four-second deadline, and the combined catalog has a five-second deadline.

Expected absence is authoritative empty state, not an error. A missing
per-project Claude directory means that registered project has no Claude
history. A missing `.claude/projects` root is empty when no contradictory
Claude history source exists. A missing Codex index, state database, and
history database together is empty. If any one Codex source exists without
both required companions, if the highest generation cannot be selected
unambiguously, or if a root is inaccessible, malformed, reparse-based, or
schema-incompatible, the provider is incomplete. These rules allow the first
session to be created while failing closed on damaged existing state.

## Name Normalization and Matching

Matching is deterministic code, never another model call. Normalization is
defined over Unicode code points:

1. Apply NFKC, then locale-independent lowercase.
2. Reject C0/C1 controls, bidi controls, unpaired surrogates, and a source name
   longer than 160 code points. For display, replace line breaks with spaces,
   collapse whitespace, redact UUID-shaped substrings, and cap at 80 code
   points.
3. Split on every code point outside Unicode categories Letter and Number.
   Discard empty tokens. `compact` is the tokens joined without separators;
   `tokenKey` is the same token multiset sorted by code-point ordinal and joined
   with U+0000. A query or candidate with fewer than two `compact` code points
   is invalid for fuzzy matching.

Each query/candidate pair receives exactly one score:

- `1.00` when `compact` values are equal.
- `0.98` when both have at least two tokens and their `tokenKey` values are
  equal. This is the only word-reordering rule.
- `0.75 + 0.20 * (shorterLength / longerLength)` when one `compact` value is a
  substring of the other.
- Otherwise, compute multiset Dice similarity over adjacent code-point bigrams:
  `dice = 2 * intersectionCount / (queryBigramCount + nameBigramCount)`. Also
  compute Levenshtein similarity `edit = 1 - distance / maxLength` only when
  `maxLength <= 40`, the length difference is at most four, and distance is no
  more than `max(1, floor(maxLength * 0.20))`. The score is
  `max(dice, edit)`; an ineligible edit value is zero.

JavaScript double precision is used without decimal rounding. Comparisons use
an epsilon of `1e-12`. A score of at least `0.70` is plausible. A unique exact
score of `1.00` may auto-select. Any other result auto-selects only when the
query has at least four `compact` code points, the best score is at least
`0.90`, and it exceeds the second-best score by more than `0.10`. A tie within
epsilon or a smaller margin is ambiguous. Scores below `0.70` count as no
match. Constants are code constants, not configuration or message input.

Candidates are totally ordered by score descending, match-kind precedence in
the order above, updated time descending with missing last, executor ordinal,
normalized project alias ordinal, display-name ordinal, and a local digest of
the provider/native identity. The digest is never displayed. Ordering never
breaks an auto-selection tie; it only stabilizes output.

A canonical candidate may have more than one validated searchable alias after
gateway/native merging. The matcher scores every distinct normalized alias and
uses the maximum score as the candidate score. Equal alias scores use the
match-kind precedence above and then normalized-alias ordinal only to choose
the candidate's diagnostic match kind; the displayed name remains the gateway
display name. Uniqueness, the second-best margin, and ambiguity are calculated
across canonical candidates, never alias rows. Therefore the same exact alias
on two candidates is ambiguous even when one candidate has additional aliases.

This supports partial names, reordered separator-delimited words, Chinese and
English names, and a small number of typing errors. It does not use synonyms,
embeddings, transcript text, or project contents.

Executor and project filters apply before scoring. Without explicit filters,
all registered projects and both executors participate, so duplicate or close
names across projects remain ambiguous rather than being resolved by recency
alone. Recency is only a deterministic output ordering input; it cannot turn
two close matches into one match.

## Ambiguity Selection

For two or more plausible candidates, the gateway stores a candidate set with
a random 128-bit selection ID, the original bounded task content, requested
name, candidate identities, capability snapshots, and a ten-minute expiry. It
returns at most ten numbered candidates showing only name, executor, registered
project alias, state, and last update time. Task content is capped at the
existing inbound-message limit; each candidate identity is a fixed schema with
bounded strings. The serialized set is capped at 64 KiB and the formatted
Lark response at 12,000 UTF-8 bytes.

The user may reply to that exact candidate-list message with one number. The
outbound Lark message ID binds the reply to the candidate set, so a bare number
outside that reply context is ignored. A more precise new name may instead run
a fresh search. Candidate-set rows are single-selection and bounded to the
newest 200 sets.

Selection does not trust the old snapshot. It performs an exact metadata and
ownership revalidation, then consumes the candidate set and enqueues the
original task. An expired, changed, missing, newly busy, or non-resumable
candidate returns a bounded error and never falls through to session creation.

Consumption is a conditional single-use update, not a separate pre-step. The
same SQLite transaction must change the candidate set from `open` to
`consumed`, record the winning inbound selection message ID and selected
ordinal, create or reuse the session and task, mark the original lookup and
selection inbox rows processed, and enqueue both acknowledgement outbox rows.
The update requires `state=open` and an unexpired timestamp. Losing that compare
and swap returns the already-recorded result and performs no mapping change or
task creation. A crash before commit leaves the set open; a crash after commit
leaves a durable queued task recovered at startup.

## Safe Resume and Import

Before resuming a native candidate, the gateway verifies all of the following:

- the native ID still resolves to the same executor and metadata source;
- its canonical working directory equals a registered project path;
- the stored name still matches the selected record;
- no active native writer or in-progress turn owns it;
- its persisted native state still exists and is accepted by the provider;
- there is no conflicting gateway import for the same executor/native ID.

Catalog records merge by `(executor, normalized native_id)` before matching.
A gateway row without a native ID remains distinct under its gateway ID. When
a gateway and native row merge, the gateway name is the display name, both
validated names are retained as searchable aliases, registered gateway project
metadata must equal the native canonical `cwd`, `busy` wins status precedence,
and update time is the maximum source time. A project conflict, executor
conflict, or two non-archived gateway rows claiming the same native identity
produces one visible `identity_conflict` candidate that blocks creation and
cannot resume. It never produces duplicate candidates.

For Codex, any held writer lock or exact in-progress turn fails as `busy`.
Otherwise the existing executor calls `thread/resume` with the validated thread
ID and registered project path. For Claude, any live process registration for
the same session fails as `busy`, including an idle interactive process,
because a second `claude --resume` process would create two writers. Otherwise
the existing executor calls `--resume <session-id>` from the registered project
path.

The pre-import validation is not execution authority. Every queued task whose
session already has a native ID carries an immutable expected native identity
and project tuple. The scheduler injects a provider-specific resume guard into
the executor. Immediately before `thread/resume`, after opening and initializing
the Codex client but before sending the resume request, the guard repeats the
exact state row, the highest-generation history database's exact latest-turn
check, writer lock, identity, and canonical-project checks. A missing or
incompatible history database, or a nonterminal latest turn, fails closed even
when no writer lock is observable. Immediately before spawning
`claude --resume`, the Claude guard repeats the exact transcript identity,
`cwd`, active-registry, PID/start-identity, and project checks. A new writer,
live process, changed identity, incomplete probe, or project mismatch fails the
task as `busy`, `stale_target`, or `snapshot_incomplete`; it never falls back
to a new session. The provider's own resume rejection remains a second
fail-closed check for the unavoidable post-guard race.

Import uses a `native_session_claims` table keyed by
`(executor, normalized_native_id)` and pointing to one non-archived gateway
session. If a valid claim already exists, that session is reused. Otherwise one
`CX-*` or `CL-*` mapping and its claim are created in the same transaction with
the native ID, registered project, and native display name. Concurrent imports
converge on one mapping. The normal scheduler then serializes tasks for that
gateway session. Provider resume rejection marks the task failed but does not
delete or replace the original native history.

Migration preflights existing non-archived sessions grouped by the same native
key. A group of one is backfilled into `native_session_claims`. A duplicate
group is recorded in `native_session_claim_conflicts`; no winner is guessed and
that identity remains `identity_conflict` until manually repaired. Archived
sessions do not hold a live claim. If an archived mapping is later restored,
claim acquisition must succeed first or restoration fails without changing
state.

## No-Match Creation

Creation is allowed only when every provider required by the effective search
scope completed successfully and without truncation, and no candidate reached
the lower match threshold. A provider timeout, parse failure, schema mismatch,
or input cap returns `Session query incomplete; no new session was created.`

The gateway then resolves executor and project using explicit fields, safe
reply/recent context, or the existing single-project rule. Missing or ambiguous
values produce one concise clarification. A resolved request creates the normal
gateway session with the user-supplied session name and enqueues the task. It
does not persist an invented fuzzy alias.

A matching but busy, corrupted, inaccessible, `project_unverified`, or
otherwise non-resumable session is not the same as no match. The gateway
reports that candidate and never creates a same-name replacement implicitly.

Before creation, the executor and project must be fully resolved. The gateway
then enters a per-`(executor, canonical project path)` lookup/create mutex,
reruns the complete scoped catalog query, and repeats name matching. Only a
second complete no-match may enter the creation transaction. This scope-level
mutex serializes even differently spelled names that fuzzy-match each other.
The creation transaction inserts a unique normalized-name claim and the
session/task/decision rows together. If a claim already exists, the request
restarts matching against its session instead of creating. The singleton
gateway owner prevents a second process from bypassing the mutex, and its
durable owner epoch is checked by the transaction.

`session_name_claims` is keyed by
`(executor, canonical_project_key, compact_name)` and points to exactly one
non-archived gateway session. Creation/import acquires it in the same
transaction as the session mapping. A rename transaction first acquires the
new key, updates the session, then releases the old key; a conflict aborts the
rename unchanged. Archiving releases the claim in the archive transaction.
Restoration must reacquire it before changing status. Native alias changes do
not move the claim because only the gateway primary name owns it. Startup
deletes a claim only when its target session is provably missing or archived;
a key/name/project mismatch is recorded as `name_claim_conflict` and fails
closed rather than being repaired by guessing.

Every acquisition path, including import, no-match creation, force-new,
rename, and restore, checks both `session_name_claims` and unresolved
`session_name_claim_conflicts` for the same key in its transaction. Any
unresolved conflict row aborts every path unchanged with fixed outcome
`name_claim_conflict`. Conflict rows fence their key until an explicit local
repair resolves the duplicate sessions and closes the row; ordinary startup
cleanup and Lark requests never delete or override them.

A valid live claim has path-specific behavior. In `continue_or_create`, losing
claim insertion to a concurrent live owner returns that owner to the matcher;
the request exits the transaction, revalidates and rescoring it with the fresh
catalog, then resumes or disambiguates instead of creating. Import reuses a
live owner only when its native claim proves the same native identity;
otherwise it reruns matching and may become ambiguous. Force-new, rename, and
restore never reuse a different live owner: they abort unchanged with fixed
outcome `name_in_use` and ask for a distinct name. No path labels an ordinary
live owner as `name_claim_conflict`.

`canonical_project_key` is the registered path after native realpath
resolution, Windows separator normalization, removal of non-root trailing
separators, and invariant case folding. The original canonical path remains in
the session row for execution and display-by-alias; only the normalized key is
used for equality and uniqueness.

## Concurrency, Idempotency, and Recovery

The inbound Lark message ID remains the request idempotency key. A
`session_lookup_requests` row stores the validated route fields, bounded task
content, state, decision, and outbox key. States are `pending`, `selection`,
`committed`, and `failed`. A message ID maps to one row forever; event
redelivery returns or repairs its existing result instead of looking up,
creating, or enqueuing again.

An import claim or normalized-name claim, session/task creation, lookup
decision `committed`, inbox `processed` state, and queued acknowledgement
outbox row are written in one SQLite transaction. The gateway revalidates a
native target immediately before that transaction. Only after commit does it
place the durable queued task into the in-memory scheduler. Provider resume
rejection later marks that task failed but cannot create another mapping.

For a numbered selection, that transaction additionally performs the
candidate-set `open` to `consumed` compare-and-swap and records the selection
message ID and ordinal. Two distinct replies racing for one list can therefore
commit at most one task. The losing reply reuses the committed selection result
and receives a deduplicated already-selected response.

Startup handles every crash window explicitly before accepting new events:

- Existing `running` and `waiting_approval` tasks retain the current
  interrupted/no-auto-retry behavior and receive the existing bounded result.
- A durable `queued` task absent from the fresh in-memory scheduler is loaded
  with its session and enqueued exactly once; the scheduler keeps an in-memory
  task-ID set to reject duplicate recovery/enqueue calls.
- A `pending` lookup has no permitted provider side effect. Startup marks it
  `failed`, marks its inbox row failed, and creates a deduplicated Lark notice
  asking the user to resend. It does not guess using a changed catalog.
- A `committed` request repairs any missing acknowledgement outbox row from its
  stored decision and relies on queued-task recovery for execution.
- A `selection` request remains selectable until its original expiry. Expired
  sets are terminalized with a deduplicated expiry response when selected.
- An inbox row left `received` without a lookup row predates a durable parsed
  route. Startup marks it failed and emits one deduplicated resend notice,
  avoiding a permanently suppressed silent request.

These repairs run under the claimed singleton owner epoch. Candidate sets
survive a gateway restart until expiry, but startup never chooses a candidate
or creates a session on the user's behalf.

## Error and Output Contract

Public outcomes use fixed Chinese messages for:

- unique existing session resumed;
- several candidates requiring selection;
- matching session busy;
- matching session not safely resumable;
- candidate changed or selection expired;
- incomplete search, so creation was suppressed;
- no match and missing executor/project;
- new session created and queued;
- provider resume rejection.
- requested name already in use for force-new, rename, or restore;
- unresolved migrated or detected name-claim conflict requiring local repair.

Raw database errors, paths outside registered project labels, native IDs,
process IDs, lock paths, transcript filenames, and command lines are logged
only as bounded local diagnostics or omitted. Lark output never contains
conversation content discovered from native storage.

Every displayed name passes the normalization section's single-line sanitizer,
UUID-pattern redaction, control/bidi removal, and 80-code-point cap. Project
output uses the registered alias only. Individual diagnostics are capped at
200 UTF-8 bytes, at most three diagnostics are included, and every response is
truncated deterministically to 12,000 UTF-8 bytes with an explicit omitted-row
count. Serialization applies byte limits after UTF-8 encoding, not only
JavaScript string length.

## Components

- `schemas/intent.schema.json`: add `continue_or_create`.
- `prompts/route.md`: define name-targeted work and preserve exact-ID/reply and
  force-new precedence.
- `src/resolver.mjs`: validate and return a name lookup request.
- `src/session-catalog.mjs`: orchestrate bounded provider metadata collection,
  normalization, project scoping, and exact revalidation.
- `src/session-name-match.mjs`: implement deterministic normalization, scoring,
  thresholds, and candidate ordering.
- `src/active-agent-codex-worker.mjs`: add bounded historical metadata queries
  without reading conversation fields.
- `src/claude-session-history.mjs`: read project-scoped UUID filenames,
  `custom-title.json`, and only the bounded allowlisted transcript-envelope
  projection needed to prove exact `cwd` and session identity.
- `src/store.mjs`: add native import claims, durable lookup outcomes, candidate
  sets, normalized-name claims, conflict records, recovery queries, and
  outbound-message selection bindings.
- `src/gateway.mjs`: run lookup, selection, import/reuse, no-match creation, and
  existing scheduler enqueue paths; dispatch bound numeric selections before
  the model router.
- `src/executors/codex.mjs` and `src/executors/claude.mjs`: invoke the injected
  exact resume guard immediately before the provider resume operation and
  surface bounded resume rejection codes.
- `test/`: add unit, provider-fixture, concurrency, routing, and gateway-flow
  coverage.
- `README.md`: document name-first reuse and ambiguity replies.

## Testing

Automated tests cover:

- routing precedence among exact gateway continuation, reply continuation,
  explicit force-new, and `continue_or_create`;
- NFKC, case, whitespace, punctuation, substring, reordered word, Chinese,
  English, typo, short-name, threshold, score-margin, and deterministic-order
  matching cases;
- exact duplicate names and close fuzzy results produce candidate selection;
- a numbered reply is accepted only for the bound outbound message and an
  unexpired candidate set; malformed bound replies bypass the model and receive
  a fixed correction;
- merged aliases use the maximum alias score, but uniqueness and score margins
  are computed across canonical candidates rather than alias rows;
- executor/project filters are applied before scoring;
- omitted filters infer from one existing match but not from ambiguous matches;
- Codex historical collection reads only allowlisted metadata columns/files;
- Claude historical collection retains only allowlisted envelope fields,
  discards message/tool properties, requires exact `cwd`, and marks missing
  proof `project_unverified`;
- expected absent provider roots are complete-empty, while contradictory,
  malformed, over-cap, inaccessible, and incompatible sources are incomplete;
- file, line, row, aggregate-byte, enumeration, timeout, canonical-containment,
  non-reparse, strict-schema, output-byte, control-character, and UUID-redaction
  limits fail closed and remain deterministic;
- one safe Codex result invokes `thread/resume` with the exact thread ID;
- one safe Claude result invokes `--resume` with the exact session ID;
- Codex writer locks/in-progress turns and all live Claude owners return busy;
- a native owner appearing while a task waits in the scheduler is caught by
  the executor's immediate pre-resume guard for both providers; Codex repeats
  the highest-generation history query and fails closed when it is missing or
  incompatible;
- stale and changed candidates fail revalidation without creating a session;
- gateway/native duplicates merge by `(executor, native_id)` with documented
  aliases and precedence; conflicting mappings remain non-resumable;
- concurrent imports produce one gateway mapping, while concurrent fuzzy
  no-match requests in one executor/project scope serialize, rerun lookup, and
  create at most one named session;
- complete no-match creates once, while incomplete/truncated/error searches
  never create;
- redelivered inbound messages and repeated selections are idempotent;
- concurrent distinct numeric replies consume one candidate set once; crash
  injection immediately before and after the consume/commit transaction proves
  respectively safe retry and one recovered durable task;
- crash tests cover received inbox rows, pending lookups, committed decisions,
  queued tasks, missing acknowledgements, and unexpired selections, proving
  each is recovered or receives one resend notice without duplicate work;
- migration fixtures cover no claims, one existing mapping, duplicate active
  mappings, archived mappings, duplicate normalized names, stale claims,
  rename transfer, archive release, and restoration without choosing an unsafe
  winner;
- every name-claim acquisition path is rejected by an unresolved conflict row;
- a concurrent live name claim restarts `continue_or_create` matching, while
  force-new, rename, and restore return `name_in_use` without mutation;
- existing create, continue, status, cancel, approval, active-list, stop, and
  CC Switch tests remain green.

Verification runs the complete Node test suite, a read-only metadata catalog
smoke test against this PC, and three Lark flows: unique fuzzy resume,
ambiguous numbered selection, and complete no-match creation. The gateway is
then restarted and its process, listener health, and outbox delivery are
verified.

## Rollout and Recovery

The database migration is additive. It creates lookup requests, candidate
sets, normalized-name claims, native-session claims, and conflict tables in one
transaction. A preflight scans existing sessions before backfill: unique active
native mappings receive claims; duplicate active mappings receive conflict rows
and no claim; archived mappings receive neither. It separately groups
non-archived sessions by `(executor, canonical_project_key, compact_name)`:
unique groups receive name claims and duplicate groups receive
`session_name_claim_conflicts` rows with no guessed winner. Migration never
rewrites or deletes an existing session, task, message binding, or stop record.
The feature is enabled only when schema, prompt, resolver, catalog, store
migration, pre-router selection dispatch, resume guards, and startup recovery
ship together. Existing gateway sessions and stop references are unchanged.

If native metadata formats are incompatible, the affected provider marks the
search incomplete. This disables implicit creation for that scope but leaves
exact gateway continuation and explicit force-new behavior available. Rolling
back the routing action and handler stops new lookups; additive metadata rows
can remain without affecting prior behavior.
