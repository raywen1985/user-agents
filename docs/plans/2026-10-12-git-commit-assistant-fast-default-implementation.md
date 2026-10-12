# Git Commit Assistant Fast-Default Implementation Plan

Date: 2026-10-12
Design: `docs/design/2026-10-12-git-commit-assistant-fast-default.md`

## Deliverables

- `skills/git-commit-assistant/SKILL.md`
- `skills/git-commit-assistant/references/commit-policy.md`
- `skills/git-commit-assistant/scripts/CommitToolkit.ps1`
- `skills/git-commit-assistant/scripts/Test-CommitToolkit.ps1`
- `skills/git-commit-assistant/evals/evals.json`

## Implementation Order

1. Snapshot the current skill in the ignored evaluation workspace for baseline comparison.
2. Add whole-invocation timing and Git subprocess counters.
3. Extract strict byte-array parsers for porcelain-v2 status, bulk attributes, numstat, and NUL path sets; expose only a test-load switch, not a new public action.
4. Replace per-file attribute and diff-stat subprocesses with fixed-count batch commands against the captured HEAD OID.
5. Add the content-safety gate for filters, unsupported encodings, and root-to-leaf reparse components before any worktree-reading diff.
6. Revalidate HEAD, branch, and index after context capture and return bounded performance diagnostics.
7. Refuse `Normalize` while saved plan state exists.
8. Change the skill workflow and policy so normalization is disabled by default and enabled only by an explicit cleanup request; prohibit patch expansion.
9. Add parser, safety, compatibility, and one-versus-100-file performance regression tests.
10. Run PowerShell 5.1 and 7 tests, syntax checks, whitespace checks, skill validation, package generation, and before/after timing comparison.
11. Add the opt-out evaluation, run updated skill versus the saved baseline, grade results, aggregate the benchmark, and generate the static review viewer.

## Compatibility Rules

- Keep action names and plan schema version 1.
- Keep the bounded 250-file stdout summary and complete `context.json` manifest.
- Keep `whitespaceOnly` Boolean and `hunks` nullable.
- Keep all existing mandatory validation, exact path selection, and no-commit/no-push boundaries.
- Return `BATCH_PARSE_FAILED` for malformed batch output without falling back to per-file Git calls.

## Verification Gates

- Whole-invocation `gitProcessCount <= 20` for one and 100 tracked files, differing by at most one.
- No configured filter, leaf symlink target, or ancestor junction target is opened during `Analyze`.
- Captured HEAD/branch/index drift stops analysis.
- Existing and new tests pass in Windows PowerShell 5.1 and PowerShell 7.
- `git diff --check`, both PowerShell parsers, skill validation, and package inspection pass.
- The generated review viewer includes the updated evaluation and quantitative results.
