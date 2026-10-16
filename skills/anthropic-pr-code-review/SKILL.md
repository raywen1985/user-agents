---
name: anthropic-pr-code-review
description: Review a pull request, branch diff, staged changes, or working-tree changes using Anthropic's multi-perspective, confidence-filtered workflow. Use for code review requests, PR audits, regression hunts, CLAUDE.md or AGENTS.md compliance checks, and requests to identify only actionable bugs with low false-positive rates.
compatibility: Requires Git. GitHub pull-request lookup or comment publishing also requires the gh CLI and authentication.
---

# Anthropic PR Code Review

Review changed code for concrete regressions and applicable repository-rule violations. Prefer a short list of well-supported findings over broad style commentary.

This is the cross-agent skill counterpart of Anthropic's `code-review` Claude Code plugin. Claude Code users can also invoke the native `/code-review` command installed from `claude-plugins-official`.

## Establish scope

1. Determine whether the target is a GitHub pull request, a branch comparison, staged changes, or working-tree changes.
2. For a pull request, use `gh pr view` and `gh pr diff` when available. Check whether it is closed, a draft, trivial or automated, or already reviewed in the current conversation. Explain and stop if a review would not be useful.
3. For local changes, inspect `git status`, the relevant diff, and the comparison base. Do not silently expand the review to unrelated files.
4. Find applicable instruction files such as `AGENTS.md`, `CLAUDE.md`, and scoped equivalents in directories containing changed files. Treat repository instructions as constraints only where they apply.
5. Summarize the intent of the change before judging it.

## Review from independent perspectives

When parallel agents are available and the change is substantial, ask independent reviewers to cover these perspectives concurrently. Otherwise, perform the passes sequentially and keep their evidence separate.

- Repository-instruction compliance. Cite the exact applicable rule; do not invent implied rules.
- Obvious behavioral bugs introduced by the diff.
- Historical context from `git blame`, relevant commits, and previous pull requests when it can change the conclusion.
- Contract and comment compliance in modified files.
- Tests and callers needed to confirm boundary behavior. Do not report missing tests by itself unless repository instructions require them or the omission hides a concrete regression.

Focus on changed behavior. Exclude pre-existing defects, cosmetic preferences, compiler or linter errors that normal CI will reliably catch, speculative security commentary, and intentional behavior changes supported by the surrounding change.

## Verify and score findings

For every candidate finding:

1. Re-read the changed lines and enough surrounding code to trace the affected path.
2. Confirm the issue was introduced by the reviewed change.
3. Check callers, tests, types, configuration, history, or documentation needed to disprove alternate explanations.
4. Assign confidence from 0 to 100:
   - `0`: false positive or pre-existing issue.
   - `25`: plausible but unverified.
   - `50`: real but minor or unlikely in practice.
   - `75`: verified and important, but some uncertainty remains.
   - `100`: directly demonstrated and expected to occur in practice.
5. Report only findings at 80 or above. If evidence cannot support that threshold, omit the finding.

Do not run a full build or typecheck merely to discover ordinary CI failures. Run a focused test or reproduction when it materially verifies a behavioral finding and is proportionate to the change.

## Report

Lead with findings ordered by severity. For each finding include:

- A concise title with severity.
- The file and smallest useful line location.
- The concrete failure scenario and why the new code causes it.
- The evidence that makes the finding high confidence.

Then list open questions or assumptions, followed by a brief summary only if useful. If there are no qualifying findings, say so clearly and mention any meaningful test gap or residual risk.

Do not publish a GitHub comment, submit a review, modify code, or change external state unless the user explicitly asks. When publication is requested, re-check PR eligibility immediately before posting and use stable links containing the full commit SHA and line range.
