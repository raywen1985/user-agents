# Git Commit Assistant Implementation Plan

Date: 2026-10-11
Design: `docs/design/2026-10-11-git-commit-assistant.md`

## Deliverables

- `skills/git-commit-assistant/SKILL.md`
- `skills/git-commit-assistant/scripts/CommitToolkit.ps1`
- `skills/git-commit-assistant/scripts/Test-CommitToolkit.ps1`
- `skills/git-commit-assistant/references/commit-policy.md`
- `skills/git-commit-assistant/evals/evals.json`

## Implementation Order

1. Build the PowerShell 5.1-compatible process, Git, JSON, hashing, locking, and atomic-state primitives.
2. Implement repository inspection and compact `Analyze` output.
3. Implement conservative normalization with byte backup, recovery journal, EOL-only restoration, and C#/Lua/JSON/XML proof adapters.
4. Implement strict `SavePlan` validation and expected tree-entry snapshots.
5. Implement mandatory safety validation, optional external-validation proposals, resume detection, and TortoiseGit launch/dry-run.
6. Implement `Status` and guarded `Clear`.
7. Add disposable-repository tests for both Windows PowerShell 5.1 and PowerShell 7.
8. Add skill instructions, policy reference, and evaluation prompts.
9. Run tests, compare skill and baseline behavior, grade results, and generate the review viewer.

## Scope Rules

- Never invoke `git commit`, `git push`, reset, clean, checkout-discard, or stash.
- Never modify the index.
- Never run repository code without current-turn human approval.
- Stop on uncertainty rather than broadening path selection or rewriting ambiguous content.
- Keep all transient state under the worktree-specific Git directory.

## Verification Gates

- `git diff --check` on created files.
- Script parser validation in PowerShell 5.1 and 7.
- Self-contained test suite passes in both hosts where available.
- Tests prove index hashes do not change.
- Dry-run proves exact logical TortoiseGit arguments.
- Skill eval viewer is generated before final handoff.
