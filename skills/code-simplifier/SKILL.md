---
name: code-simplifier
description: Simplify and refine existing code for clarity, consistency, and maintainability while preserving behavior. Use after code has been written or modified, when the user asks to simplify, clean up, refactor for readability, reduce nesting or duplication, or make a recent diff easier to understand without changing functionality.
---

# Code Simplifier

Improve code structure without changing observable behavior. Prefer readable, explicit code over dense or clever reductions.

This is the cross-agent skill counterpart of Anthropic's `code-simplifier` Claude Code plugin. Claude Code also has the native `code-simplifier` subagent installed from `claude-plugins-official`.

## Choose the scope

1. Use the files or symbols named by the user.
2. If no scope is named, focus on code modified in the current conversation or the current Git diff.
3. Do not broaden the task into repository-wide cleanup unless the user requests it.
4. Read applicable `AGENTS.md`, `CLAUDE.md`, formatter, linter, and nearby-code conventions before editing.

## Simplify safely

Look for changes that materially improve comprehension:

- Reduce unnecessary nesting and control-flow indirection.
- Remove duplication, dead branches, redundant temporaries, and abstractions that no longer earn their complexity.
- Clarify names and group related logic.
- Replace nested conditionals or ternaries with a clearer decision structure when appropriate.
- Remove comments that only restate the code, while preserving comments that explain constraints, intent, or non-obvious tradeoffs.
- Keep useful boundaries between concerns; fewer lines are not automatically simpler.

Preserve public APIs, side effects, ordering, error behavior, logging, serialization, performance-sensitive behavior, and edge cases unless the user explicitly authorizes a behavior change. Do not hide meaningful logic in clever expressions or merge unrelated responsibilities.

## Work in verifiable increments

1. Understand the existing behavior and identify invariants before editing.
2. Make the smallest coherent simplification.
3. Inspect the resulting diff for accidental semantic changes and unrelated formatting churn.
4. Run the narrowest relevant tests, formatter, or static checks that are available and proportionate.
5. If behavior cannot be verified, state the specific validation gap rather than claiming equivalence.

Summarize only significant structural changes and validation results. Avoid narrating obvious line-by-line edits.
