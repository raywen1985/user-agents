# Auto-Discovered Agent Projects Design

Date: 2026-10-16
Status: Draft for specification review

## Problem

The gateway currently treats `config/projects.json` as both a routing catalog
and an execution allowlist. Native session discovery is therefore limited to
registered projects. When a user names a Claude Code session that belongs to an
unregistered project, the gateway does not inspect that project, reports a
false no-match, and may create a same-name session in the only registered
project.

This happened for `导入设置优化`. The original Claude session was under
`D:\ulibs\client`, while the only registered project was
`D:\WA\unity_asset`. The first request created a different native session in
`unity_asset`. A later request found that gateway row, but native revalidation
required a Claude `custom-title.json` that the newly created session did not
have, so it returned `stale_target`.

## Goals

- Discover resumable Claude Code and Codex sessions across all local projects
  represented in their native history stores.
- Derive project ownership from validated native `cwd` metadata instead of a
  mandatory gateway registration entry.
- Fuzzy-match a supplied session name across all discovered projects unless an
  explicit executor or project filter narrows the search.
- Resume the original native session when one safe, unambiguous match exists.
- Preserve ambiguity selection, busy-session checks, name/native claims,
  project serialization, and provider-specific resume guards.
- Support optional project aliases and excluded directory roots without making
  aliases a prerequisite for discovery.
- Never fall back to an arbitrary or sole project when a name search has no
  match.
- Fix revalidation of gateway-created Claude sessions whose transcript exists
  but whose native custom-title sidecar does not.

## Non-Goals

- Accepting an arbitrary filesystem path supplied by a Lark message as
  execution authority.
- Scanning the whole filesystem for source repositories.
- Inferring project ownership from Claude's lossy encoded directory name.
- Matching session names from conversation bodies, prompts, summaries, or tool
  output.
- Changing Claude's enabled tool list or granting shell access. The separate
  restriction to `Read,Edit,Write,Glob,Grep` remains unchanged by this design.
- Automatically resuming a busy native session or bypassing the existing exact
  ownership checks.

## Considered Approaches

### 1. Keep mandatory registration and add every project manually

This preserves the current allowlist, but it does not satisfy the remote
workflow. A session can exist in Claude Code or Codex while remaining invisible
until configuration is edited and the gateway is restarted. It also recreates
the operational failure that prompted this change.

### 2. Accept any absolute path from the Lark message

This removes configuration friction but lets message parsing select any local
directory. It broadens a naming request into arbitrary filesystem execution
authority and makes project validation depend on untrusted input. This approach
is rejected.

### 3. Discover projects from native session metadata, with optional policy

This is the selected approach. Claude and Codex already persist the native
session ID and original `cwd`. The gateway can discover those records from
fixed user-profile roots, canonicalize the recorded directory, and use it as
the project identity. Optional configuration supplies aliases and exclusions;
it does not determine whether a project can be found.

## Project Identity

A project is identified internally by the case-insensitive canonical Windows
path returned by `fs.realpathSync.native`. A discovered project record contains:

- `path`: canonical absolute directory path;
- `key`: normalized canonical path used for equality and serialization;
- `label`: configured alias when available, otherwise the final directory
  component;
- `display`: the label when unique, otherwise `label | full path`;
- `aliases`: configured aliases plus deterministic native labels;
- `sources`: `gateway`, `claude`, and/or `codex`;
- `updatedAt`: newest contributing session timestamp.

The canonical path, not the label, remains authoritative. Duplicate directory
names on different drives or parents are separate projects and must not be
resolved by recency. Candidate output includes enough path context to
distinguish them.

Every usable project record also carries one or more current authority proofs:

- an exact Claude transcript/session ID whose bounded envelope proves the
  canonical `cwd`;
- an exact Codex state/session ID whose row proves the canonical `cwd`; or
- an explicit local project override loaded from the gateway-owned
  configuration file.

A Gateway database row is not an authority proof. It can contribute a session
name, binding, status, and native identity only after the row's project path is
corroborated by one of the sources above. This prevents an old or malformed
`sessions.project_path` value from bootstrapping execution access.

Existing `sessions.project_alias` rows remain valid. Newly imported sessions
store the configured alias when one exists; otherwise they store a stable
derived label containing the directory name and a short digest of the canonical
path. Scheduler serialization uses canonical `project_path` conflict checks:
two paths conflict when they are equal or either is an ancestor of the other.
This preserves the old registered-root overlap invariant for automatically
discovered roots such as `D:\ulibs` and `D:\ulibs\client`. Label differences
cannot permit concurrent work in equal or nested directories.

## Configuration

`config/projects.json` becomes optional project policy and display metadata,
not an allowlist. The existing `projects` array remains backward compatible:
its entries are explicit local project overrides and provide preferred aliases
for matching paths. An override is a trusted onboarding source for its exact
canonical path, but a project absent from the array is still discoverable and
resumable when native metadata supplies authority.

The file may additionally contain `excludedRoots`, an array of canonical
absolute directory roots. A project whose canonical path equals or lies below
an excluded root is omitted from discovery and cannot be imported, created, or
continued through the gateway. Overlapping aliases remain invalid. Missing or
empty `projects` and `excludedRoots` arrays are valid.

Exclusions are checked after canonicalization. Missing, inaccessible, relative,
reparse-backed, or malformed exclusion roots make configuration loading fail
closed. A configured alias cannot override an exclusion.

## Native Discovery

### Claude Code

The Claude collector starts from the fixed
`%USERPROFILE%\.claude\projects` root and enumerates its immediate project
directories. It does not decode a directory name into a project path. Within
each safe directory it enumerates top-level UUID `.jsonl` transcripts and the
optional `<session-id>\custom-title.json` sidecar.

For a titled native session, the collector reads the same bounded transcript
metadata prefix used today and requires a record containing both the exact
session ID and an absolute `cwd`. It canonicalizes that `cwd`, verifies that it
is an existing ordinary directory, rejects excluded roots, and uses it as the
project path. The encoded storage directory is only a container and never
ownership proof.

A title sidecar is still required for a native-only session to participate in
name matching. Untitled transcripts are not searched by prompt content.

For a gateway row that already owns the native Claude ID, revalidation may use
the gateway's stored name, exact transcript path/ID, and verified transcript
`cwd` even when `custom-title.json` is absent. This handles gateway-created
sessions without weakening native-only name discovery. A changed title, ID,
or `cwd`, or a missing transcript, still fails closed.

### Codex

The Codex collector already reads the global `session_index.jsonl`, state
database, and thread-history database. Each record's native `cwd` is now
canonicalized and validated directly instead of being discarded when it does
not map to configured project data. Excluded roots are removed. Missing,
relative, inaccessible, or unsafe paths produce a non-resumable record or an
incomplete provider result; they never become execution paths.

### Gateway rows

Non-archived gateway sessions remain catalog inputs. Their stored project path
is canonicalized and checked against exclusions, but it is usable only when the
same canonical path has a current native or explicit-override authority proof.
If a gateway row has a native ID, it must merge with the corresponding native
record or pass the appropriate gateway-owned revalidation rule. Conflicting
native IDs, executors, or canonical paths remain `identity_conflict`.

The gateway adds a `project_authorities` table to persist the exact source used
when a task/session is committed: canonical project key and path, source type,
provider, native session ID or override identity, bounded source locator, and
creation/update timestamps. Persisted authority is a revalidation recipe, not
permanent permission. Gateway rows without one valid current recipe cannot be
continued or used to create another session. Migration backfills authority only
when the configured override or current native metadata independently proves
the same canonical path; it never trusts `sessions.project_path` alone.

## Bounded Global Scan

Global discovery remains bounded and fail closed:

- Claude's projects root allows at most 2,048 immediate directories and 20,000
  candidate transcript entries in total.
- Each title sidecar remains capped at 4 KiB and each metadata prefix at
  256 KiB and 64 records.
- Codex retains its 32 MiB index, 20,000-line, and database-query bounds.
- Gateway enumeration reads non-archived sessions in deterministic update/ID
  order with a 20,000-row limit plus one sentinel row. Exactly 20,000 rows is a
  complete bounded result; a 20,001st row marks the Gateway source incomplete
  and discards the actionable catalog instead of silently truncating it.
- Each provider retains a four-second deadline and the combined lookup a
  five-second deadline.
- A cap, timeout, malformed source, unsafe path, or partial native store marks
  that provider incomplete.

All providers relevant to an operation must be complete before the gateway may
act. Session-name matching without a project query requires the requested
executor's native provider, or both native providers when the executor is
omitted. Project-query resolution, project candidate generation/consumption,
and any no-match creation decision always require both Claude and Codex project
collectors to be complete, even when the requested worker executor is fixed.
This prevents an incomplete Codex scan from hiding `D:\B\client` while a
complete Claude scan appears to make `D:\A\client` unique. Gateway database
enumeration must also complete in every scope.

Only after the applicable completeness rule passes may the gateway
automatically select, display an actionable numbered selection, import, resume,
or conclude no-match. An incomplete scan may return only a diagnostic error
with non-actionable counts; it cannot prove that a visible candidate is unique
because an omitted record may have the same name. This check occurs before the
current `selected` branch and again before consuming a stored candidate set.

Directories and files below the fixed native metadata roots are checked with
`lstat`; reparse points and unexpected file types fail closed. Native source
paths never come from a Lark message.

## Routing and Lookup

The router no longer receives or follows the rule "if exactly one configured
project exists, use it." An omitted project remains `null` for
`continue_or_create`. The session catalog then searches all projects for the
requested executor, or both executors when none is specified.

The router treats a project phrase as a bounded `project_query`, not a resolved
alias and never as a filesystem path. It may copy the user's short project
phrase but cannot convert it into execution authority. The resolver matches the
query deterministically against the current discovered labels and configured
aliases after discovery. Path-shaped, control-containing, oversized, absent, or
invented queries resolve to no project and never become a `cwd`.

An explicit project phrase is treated as a filter over discovered project
labels and configured aliases. One exact project match narrows the catalog.
Several project matches remain ambiguous and are represented by the normal
session candidate list; no project is selected by recency alone. Project choice
for explicit `new` and complete no-match creation uses a separate durable
`project_candidate_sets` binding. The response shows at most ten numbered
projects with display label, canonical path, native source types, and latest
activity. Only a numeric reply to that exact outbound message may select one.
Selection re-runs global discovery and authority validation before committing
the task. Bare numbers, expired sets, changed authority, and newly excluded
paths do nothing.

For the request `claude 导入设置优化会话中 检查是否需要提交`, lookup searches
all Claude projects, matches the native title under `D:\ulibs\client`, verifies
its transcript `cwd`, and resumes its native ID. It must not inspect only
`unity_asset`, create a replacement, or use a recent gateway row to override a
better exact native-title match.

## No-Match Behavior

A complete no-match result may create a session only when both executor and
project are explicit and the project resolves to a currently authorized
canonical path. If the project is omitted, the gateway returns the bounded
project candidate selection described above. It never defaults to a sole
configured, discovered, or recent project.

An explicit `new` request follows the same project rule. Optional aliases can
make project selection concise, but they are not required for resuming an
existing named session. Arbitrary message-provided paths are not accepted as a
shortcut. A project with no Claude, Codex, or gateway history is outside this
feature and needs a separate local configuration or onboarding mechanism.

## Revalidation and Execution

Before import and immediately before provider resume, the gateway repeats:

- native session identity and metadata-source validation;
- canonical `cwd` existence and equality;
- excluded-root evaluation;
- title equality for native-only Claude candidates;
- gateway-owned transcript/name validation for mapped untitled Claude
  sessions;
- live-process, writer-lock, and in-progress-turn checks;
- native and name claim conflict checks.

Every executor run, including a new or native-less session, performs a common
project guard immediately before `claude` spawn or Codex `thread/start`. The
guard recanonicalizes the directory, requires equality with the committed path,
rechecks exclusions, and revalidates the persisted native or explicit-override
authority recipe. A removed directory, changed reparse topology, missing native
evidence, incomplete provider snapshot, or policy change fails the task before
any worker starts. Provider-specific resume guards run in addition to this
common guard for sessions with native IDs.

`projectForCandidate` is replaced by a constructor that accepts only the
candidate's already verified canonical project record. It no longer requires a
match in `config.projects`.

Codex's read-approval policy currently initializes from registered project
roots. It will be adjusted so every classification validates the current
session's canonical project root and independently rejects protected analyzer,
host, or profile paths. Before enabling automatic read approval for any dynamic
root, both the common project guard and the classifier repeat the full
containment invariant: if the analyzer, an allowlisted PowerShell host, or any
applicable existing or expected profile path equals or lies beneath that
writable project root, automatic read approval is disabled for the task. This
check uses the current canonical/protected-file digests and fails closed on
missing, changed, inaccessible, or reparse-backed paths. Auto-discovery must not
silently disable the existing project-local path boundary.

## Error Handling

- `busy`: the exact native session has a live owner or in-progress turn.
- `project_excluded`: the verified native `cwd` is under an excluded root.
- `project_unverified`: native metadata does not prove a safe canonical `cwd`.
- `identity_conflict`: gateway and native records disagree about identity or
  project.
- `snapshot_incomplete`: a provider could not complete the bounded scan.
- `stale_target`: exact source metadata changed after selection.

When a unique candidate becomes stale during revalidation, the service performs
one fresh full lookup within the original deadline. It may continue a newly
verified unique match or return an updated ambiguity/busy/error result. It never
creates a session after a stale result. This removes an unnecessary Lark round
trip for transient metadata changes without hiding a real conflict.

## Migration and Compatibility

No existing gateway session, task, claim, or binding is deleted. Existing
registered project entries become explicit override authorities and aliases for
the same canonical paths. Existing database project paths are retained but are
not authoritative until migration or a later lookup attaches a current
authority proof.

The feature ships atomically with global collectors, dynamic project
construction, router-prompt changes, Claude mapped-session revalidation,
dynamic read-policy validation, tests, and README updates. Rolling back restores
mandatory registration behavior; additive discovered labels require no schema
cleanup.

## Tests

Automated coverage must prove:

- Claude global discovery finds a titled session in an unregistered project and
  obtains the project only from transcript `cwd` metadata;
- Codex global discovery retains an unregistered but valid native `cwd`;
- the exact `导入设置优化` fixture resumes the `D:\ulibs\client` session rather
  than creating one in `unity_asset`;
- omitting a project never injects the sole configured project into routing;
- a complete no-match without an explicit discovered project asks for project
  selection and creates nothing until a bound reply is revalidated;
- an incomplete relevant provider scan cannot auto-select, expose an actionable
  candidate selection, import, resume, or create even when one exact candidate
  was observed;
- a Gateway-only row without native or explicit-override project authority
  cannot authorize continuation or creation;
- an explicit `new` request can select an unregistered project discovered from
  native metadata, while a message-provided arbitrary path cannot;
- duplicate discovered project labels produce a bound project selection and
  are never resolved by recency;
- project-query resolution requires complete Claude and Codex discovery, so a
  duplicate label omitted by the other provider cannot become a false unique
  project;
- configured aliases narrow discovery but do not define eligibility;
- duplicate leaf directory names remain ambiguous;
- excluded roots block native, gateway, import, continuation, and creation
  paths;
- lossy Claude directory names cannot establish project ownership;
- a gateway-created Claude transcript without `custom-title.json` passes the
  mapped-session revalidation path when ID and `cwd` still match;
- a native-only untitled Claude transcript is not name-searchable;
- stale revalidation retries lookup once and never falls through to creation;
- new and native-less sessions recanonicalize and revalidate their project
  authority immediately before worker start;
- unsafe, missing, relative, reparse-backed, oversized, timed-out, or malformed
  metadata marks discovery incomplete;
- Gateway enumeration is complete at 20,000 non-archived rows and fails closed
  at 20,001 rather than retaining the current silent 200-row truncation;
- project serialization remains keyed by canonical path;
- equal and ancestor/descendant project roots never run concurrently, while
  unrelated roots retain existing parallelism;
- Codex read approval remains confined to the dynamically discovered project;
- automatic read approval is disabled when a dynamic project root contains the
  analyzer, an allowlisted PowerShell host, or any applicable profile path;
- all existing resume, selection, stop, approval, CC Switch, and scheduler tests
  remain green.

## Operational Verification

Run the complete Node test suite and `git diff --check`. Perform read-only local
smoke discovery and verify that both `D:\ulibs\client` and
`D:\WA\unity_asset` appear with their native sessions. Restart
`LarkClaudeGateway`, verify listener health, and send the Lark request
`claude 导入设置优化会话中 检查是否需要提交`. The queued header must identify
the `D:\ulibs\client` project and the gateway must resume native session
`fb0f2ece-ee8e-46fb-a7e4-84d1c662a62a` rather than create a new native ID.

The resumed Claude worker may still report that Bash is unavailable because
shell enablement is explicitly outside this design. That separate limitation
must be reported rather than mistaken for a discovery failure.
