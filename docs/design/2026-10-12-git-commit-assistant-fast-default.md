# Git Commit Assistant Fast-Default Design

Date: 2026-10-12
Extends: `docs/design/2026-10-11-git-commit-assistant.md`

## 1. Purpose

Reduce the latency of ordinary commit-preparation requests while making diff-noise cleanup explicitly opt-in.

The existing safety model remains unchanged: the skill does not stage, commit, push, broaden file selections, expose secret values, or execute repository code without current-conversation approval.

## 2. User-Facing Behavior

Diff-noise normalization is disabled by default. A normal request to organize changes or open TortoiseGit runs analysis, grouping, validation, and handoff without invoking `Normalize`.

Enable normalization only when the user explicitly asks to clean or remove whitespace, blank-line, encoding, BOM, line-ending, or other invalid diff noise. Explicit requests to preserve the original diff or skip cleanup keep it disabled. Ambiguous requests use the disabled default without adding a clarification round trip.

The preparation report states one of:

- `normalization: disabled (default)`;
- `normalization: disabled (user requested)`;
- `normalization: enabled (user requested)` with the existing proof and skip report.

Resuming a saved plan never introduces normalization that was not performed before `SavePlan`.

`Normalize` must refuse to run whenever `plan.json` or `state.json` exists. The user must finish or explicitly `Clear` the saved plan before starting a new cleanup pass. This makes the pre-plan normalization boundary enforceable without changing plan schema version 1. Normalization mode is reported for the current preparation invocation; it is not reconstructed as historical metadata during resume.

## 3. Fast Analysis

`Analyze` becomes a fast manifest operation. Its Git subprocess count must remain approximately constant as the changed-file count grows.

Use these batch operations:

1. one porcelain-v2, NUL-delimited status capture;
2. one NUL-delimited `check-attr --stdin` request for every changed path;
3. one NUL-delimited `diff <captured-head-oid> --numstat --no-renames` request for tracked changes when `HEAD` exists and the attribute gate is safe;
4. one NUL-delimited `diff <captured-head-oid> --name-only --ignore-all-space --no-renames` request to preserve the Boolean `whitespaceOnly` contract when the attribute gate is safe;
5. one recent-subject log request;
6. the existing fixed repository-state and operation checks.

Classify a path as a reparse point before reading its size, bytes, hash, or eligible untracked secret content. Reparse entries retain path/status metadata but receive no content-derived metadata, and analysis never opens their targets. For ordinary files, read size, type, hash, and eligible untracked secret content locally. Do not request a patch during default analysis.

The existing `hunks` field remains nullable and returns `null` in fast analysis, consistent with its existing behavior for untracked, deleted, oversized, or unavailable patches. `whitespaceOnly` remains Boolean: it is `false` for untracked, deleted, renamed, copied, binary, unborn-HEAD, or attribute-gated entries. For another tracked changed path, it is `true` only when that path is absent from the bulk `--ignore-all-space` name set, meaning no substantive difference remains after whitespace is ignored; membership means `false`. Add `diffDetailsDeferred: true` and an analysis summary containing `mode: fast`, elapsed milliseconds, and Git subprocess count.

Parse batch output defensively. Attribute records must map exactly to requested canonical paths. The status command pins rename-only detection with `--find-renames=50%` and disables copy detection regardless of repository configuration. Both bulk diff commands use `--no-renames`. Rename status entries keep `originalPath` from porcelain and receive `added`, `deleted`, `hunks` as `null` and `whitespaceOnly` as `false`; their recognized old/new decomposition records are not assigned to another file. Ordinary numstat records map by exact canonical path. Binary counts remain `null`. Missing statistics are allowed for staged/conflicted paths so the preserved safety gate can return `INDEX_NOT_CLEAN` or `CONFLICTS_PRESENT` before statistics matter. Unexpected, duplicate, truncated, invalid-numeric, or otherwise malformed records stop with `BATCH_PARSE_FAILED`.

When `HEAD` is unborn, skip both bulk diff commands and return nullable line/hunk statistics plus `whitespaceOnly: false`; later actions retain the existing `UNBORN_HEAD` stop. Compare against the captured HEAD OID, rather than the index, so staged and unstaged endpoint changes share one deterministic basis. Classify staged/conflicted state from porcelain before consuming optional statistics.

Run the bulk attribute request before either diff. If any changed path has `filter` or `ident` enabled, or has an unsupported `working-tree-encoding`, skip both optional bulk diff commands for the entire snapshot and report the affected path/rule without values. This conservative whole-snapshot gate prevents Git from starting clean/process filters and avoids unsafe long path lists. Mandatory later safety checks still reject selecting such paths. Add a process-sentinel test proving that no configured filter starts during `Analyze`.

Use the captured immutable HEAD OID in both diff commands, never symbolic `HEAD`. Immediately before returning or persisting context, re-read HEAD and branch and compare them with the captured values. Any concurrent commit, reset, checkout, or branch change returns `WORKTREE_DRIFT`; the index-byte check remains mandatory.

## 4. Deferred Detail

Detailed work occurs only when it can change a decision:

- an explicit cleanup request runs `Normalize`, whose proof adapters may inspect zero-context hunks for eligible files;
- mandatory validation continues to inspect the selected group as required.

Do not emit or persist patch text in this version. There is no toolkit-owned redaction channel that can prove a tracked patch safe before returning it, so an ambiguous group is reported as mixed and the user is asked to reorganize or identify its intent. Do not add a repository-wide deep-analysis mode. This avoids recreating the slow path under another default, prevents pre-validation secret disclosure, and keeps token usage bounded.

## 5. Internal Refactor

Replace per-file `Get-PathAttributes` calls with a bulk attribute map. Replace per-file `Get-ChangeStats` calls with a bulk numstat map. Remove default calls that calculate hunk count and run `git diff --quiet --ignore-all-space` once per file.

`Get-Context` remains the shared snapshot producer for `Analyze`, `Normalize`, `SavePlan`, and `OpenNext`. All callers receive the same status, hashes, attributes, and safety flags. Only explicit normalization performs per-file proof work.

Count Git subprocesses in `Invoke-Git` rather than estimating them. Start the counter and monotonic stopwatch before `Resolve-Repository`, so diagnostics cover the complete toolkit invocation. For `Analyze`, return `summary.performance.mode`, `summary.performance.elapsedMilliseconds`, and `summary.performance.gitProcessCount`. Diagnostics contain counts and durations only, never command output, file contents, environment values, or secret matches.

## 6. Compatibility and Safety

- Preserve action names, plan schema version 1, existing file-record fields, and the Boolean type of `whitespaceOnly`.
- Preserve byte-level index hashing before and after actions.
- Preserve staged-change, conflict, active-operation, detached-HEAD, filter, encoding, secret, drift, and path safety stops.
- Inspect reparse metadata before every local content access and never follow a reparse target during analysis.
- Run no diff command capable of worktree conversion until the attribute gate proves the complete changed path set free of custom filters, `ident`, and unsupported encodings.
- Keep `Normalize` available with the same conservative proof adapters and transactional recovery.
- Do not cache repository state across invocations; every action captures current status and hashes.
- If a batch command or parser fails, stop with `BATCH_PARSE_FAILED` rather than falling back to the old per-file slow loop.

## 7. Skill and Evaluation Changes

Update `SKILL.md` so normalization is an opt-in branch rather than a mandatory workflow step. Update the policy reference to state the default and triggering conditions.

Add an evaluation prompt that asks for an ordinary commit while explicitly preserving the original diff. Its assertions require skipping `Normalize`, retaining the original worktree bytes, and continuing through analysis and grouping.

Keep the existing noise-cleanup evaluation; it must still invoke `Normalize` because the user explicitly requests cleanup.

## 8. Tests

Extend the disposable PowerShell test suite with:

1. a large changed-file fixture proving that the saved `context.json` contains all paths while the bounded stdout summary retains its existing 250-file limit;
2. whole-invocation `gitProcessCount <= 20` for both one-file and 100-file tracked-change fixtures, with the two counts differing by at most one;
3. ordinary, deletion, binary, and rename numstat parser coverage, including spaces and Unicode in paths;
4. negative parser fixtures for duplicate, missing attribute, unexpected, truncated, and invalid-numeric records, all returning `BATCH_PARSE_FAILED`;
5. bulk attribute mapping coverage;
6. porcelain-v2 rejection fixtures for unknown kinds, duplicate paths, empty paths, truncated rename records, and empty rename sources;
7. semantic fixtures proving whitespace-only edits map to `true` and substantive edits map to `false`;
8. compatibility assertions that `hunks` remains present and nullable while `whitespaceOnly` remains Boolean;
9. index-byte preservation and fsmonitor suppression under the bulk path;
10. filter-process sentinel coverage before bulk diff;
11. a locked external reparse target proving analysis classifies the entry without opening its target;
12. captured-HEAD drift detection;
13. `Normalize` refusal while a saved plan exists;
14. PowerShell 5.1 and PowerShell 7 runs.

Keep batch parsers as byte-array-to-object functions that can be loaded by the test harness without executing a toolkit action; the implementation may use a test-only load switch or a small parsing module. Use subprocess count as the hard performance regression assertion because wall-clock thresholds are unreliable across machines. Record before/after elapsed time on the same synthetic repository as informative evidence.

## 9. Acceptance Criteria

- Ordinary commit requests do not invoke or recommend `Normalize` unless the user explicitly requests cleanup.
- Explicit cleanup requests retain the existing conservative normalization behavior.
- A large change set no longer starts Git subprocesses per file during `Analyze`.
- Default analysis emits no patch and preserves bounded model context.
- Existing consumers still receive all prior file-record keys.
- All mandatory safety checks and exact TortoiseGit selection behavior remain unchanged.
- Tests pass on Windows PowerShell 5.1 and PowerShell 7.
