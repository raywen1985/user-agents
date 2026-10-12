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

## 3. Fast Analysis

`Analyze` becomes a fast manifest operation. Its Git subprocess count must remain approximately constant as the changed-file count grows.

Use these batch operations:

1. one porcelain-v2, NUL-delimited status capture;
2. one NUL-delimited `check-attr --stdin` request for every changed path;
3. one NUL-delimited `diff --numstat` request for tracked changes;
4. one recent-subject log request;
5. the existing fixed repository-state and operation checks.

Read file size, type, hash, and eligible untracked secret content locally. Do not request a patch during default analysis.

The existing `hunks` and `whitespaceOnly` fields remain in the file records for schema compatibility, but fast analysis returns `null`. Add `diffDetailsDeferred: true` and an analysis summary containing `mode: fast`, elapsed milliseconds, and Git subprocess count.

Parse batch output defensively. Attribute records must map exactly to requested canonical paths. Numstat parsing must cover ordinary, deleted, and renamed paths and must reject malformed records instead of silently assigning statistics to the wrong file.

## 4. Deferred Detail

Detailed patch work occurs only when it can change a decision:

- an ambiguous file-level group may be expanded with a narrowly scoped `git diff --unified=1 -- <exact paths>` after secret scanning;
- an explicit cleanup request runs `Normalize`, whose proof adapters may inspect zero-context hunks for eligible files;
- mandatory validation continues to inspect the selected group as required.

Do not add a repository-wide deep-analysis mode. This avoids recreating the slow path under another default and keeps token usage bounded.

## 5. Internal Refactor

Replace per-file `Get-PathAttributes` calls with a bulk attribute map. Replace per-file `Get-ChangeStats` calls with a bulk numstat map. Remove default calls that calculate hunk count and run `git diff --quiet --ignore-all-space` once per file.

`Get-Context` remains the shared snapshot producer for `Analyze`, `Normalize`, `SavePlan`, and `OpenNext`. All callers receive the same status, hashes, attributes, and safety flags. Only explicit normalization performs per-file proof work.

Count Git subprocesses in the invocation wrapper rather than estimating them. Measure elapsed time with a monotonic stopwatch. Diagnostics contain counts and durations only, never command output, file contents, environment values, or secret matches.

## 6. Compatibility and Safety

- Preserve action names, plan schema version 1, and existing file-record fields.
- Preserve byte-level index hashing before and after actions.
- Preserve staged-change, conflict, active-operation, detached-HEAD, filter, encoding, secret, drift, and path safety stops.
- Keep `Normalize` available with the same conservative proof adapters and transactional recovery.
- Do not cache repository state across invocations; every action captures current status and hashes.
- If a batch command or parser fails, stop with a stable error rather than falling back to the old per-file slow loop.

## 7. Skill and Evaluation Changes

Update `SKILL.md` so normalization is an opt-in branch rather than a mandatory workflow step. Update the policy reference to state the default and triggering conditions.

Add an evaluation prompt that asks for an ordinary commit while explicitly preserving the original diff. Its assertions require skipping `Normalize`, retaining the original worktree bytes, and continuing through analysis and grouping.

Keep the existing noise-cleanup evaluation; it must still invoke `Normalize` because the user explicitly requests cleanup.

## 8. Tests

Extend the disposable PowerShell test suite with:

1. a large changed-file fixture proving that `Analyze` returns all paths while Git subprocess count stays under a fixed ceiling independent of file count;
2. ordinary, deletion, and rename numstat parser coverage, including spaces and Unicode in paths;
3. bulk attribute mapping coverage;
4. compatibility assertions that `hunks` and `whitespaceOnly` remain present and are `null` in fast mode;
5. index-byte preservation and fsmonitor suppression under the bulk path;
6. PowerShell 5.1 and PowerShell 7 runs.

Use subprocess count as the hard performance regression assertion because wall-clock thresholds are unreliable across machines. Record before/after elapsed time on the same synthetic repository as informative evidence.

## 9. Acceptance Criteria

- Ordinary commit requests do not invoke or recommend `Normalize` unless the user explicitly requests cleanup.
- Explicit cleanup requests retain the existing conservative normalization behavior.
- A large change set no longer starts Git subprocesses per file during `Analyze`.
- Default analysis emits no patch and preserves bounded model context.
- Existing consumers still receive all prior file-record keys.
- All mandatory safety checks and exact TortoiseGit selection behavior remain unchanged.
- Tests pass on Windows PowerShell 5.1 and PowerShell 7.
