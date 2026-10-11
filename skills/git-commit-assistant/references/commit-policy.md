# Commit Preparation Policy

## Safety precedence

Safety gates override convenience. Stop instead of guessing when repository state, path identity, encoding, syntax, filter behavior, or plan completion is ambiguous.

## Normalization proofs

The tool may rewrite only when it records one of these proofs:

- `exact-base-restoration`: the complete worktree change is non-semantic noise, so exact base bytes are restored.
- `unchanged-line-eol`: only unique, byte-equal base/current lines receive their original base terminator.
- `csharp-trivia`: an independent blank-only hunk is outside strings, comments, raw/verbatim/interpolated regions, and directives.
- `lua-trivia`: an independent blank-only hunk is outside quoted/long strings and comments.
- `json-model`: strict JSON remains valid and its significant token stream is identical.
- `xml-element-only`: repository policy explicitly marks the path element-only and secure parsing succeeds before and after.

Mixed semantic/whitespace hunks, new files without explicit policy, unsupported encodings, reparse points, binary/generated/LFS files, submodules, filters, and ambiguous lexical regions are skipped.

## Grouping

A group should be independently useful and reversible:

- keep implementation with directly proving tests;
- keep required schema/config changes before dependent behavior;
- keep a rename with edits to that renamed file;
- separate unrelated docs, cleanup, refactors, fixes, and features;
- never duplicate a path across groups;
- never automatically split one file.

Use dependency IDs only when one group must precede another. Every dependency must reference an earlier, existing group and the graph must be acyclic.

## Message inference

Use the newest 20 subjects as evidence. Prefer the dominant pattern, not a single unusual commit. Preserve the repository's language, prefix/scope convention, capitalization, punctuation, and approximate subject length.

Fallback:

```text
<type>(<optional-scope>): <concise Chinese subject>
```

Use `feat`, `fix`, `refactor`, `docs`, `test`, `build`, `ci`, or `chore` according to the actual intent. Explain why in a body only when recent history commonly uses bodies or the change needs migration/risk context.

## Validation

Mandatory checks cannot be disabled:

- clean index and no conflict/history operation;
- exact HEAD, path, status, mode, and worktree hashes;
- secret scan over all selected added/untracked content;
- JSON and secure XML parsing;
- `git diff --check`;
- exact path containment and TortoiseGit command length.

`none` skips only optional lint/build/test commands. Repository code requires a short-lived proposal ID plus explicit current-conversation human approval.

## TortoiseGit handoff

The tool passes logical argv elements without embedded syntax quotes:

```text
/command:commit
/path:C:\repo\a.cs*C:\repo\b.lua
/logmsgfile:C:\repo\.git\git-commit-assistant\messages\<launch-id>.txt
```

Never replace an overlong exact list with a directory. Stop with `COMMAND_LINE_TOO_LONG`.
