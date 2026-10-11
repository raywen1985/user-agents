# Git Commit Assistant Skill Design

Date: 2026-10-11

## 1. Purpose

Create a reusable `git-commit-assistant` skill for Windows repositories. It prepares small, reviewable Git commits while keeping the final commit action under explicit user control in TortoiseGit.

The skill must:

- remove provably safe diff noise from supported text files;
- avoid changing semantic content;
- summarize changes compactly to reduce model token use;
- split unrelated changes into file-level commit themes;
- learn the target repository's recent commit-message style;
- run proportionate local validation;
- open one TortoiseGit commit window at a time with the message filled and only the current theme's paths selected;
- resume the remaining plan when the user invokes the skill again.

The skill must not run `git commit`, `git push`, destructive cleanup, deployment, migrations, or dependency installation.

## 2. User Decisions

- Remove only noise introduced by the current work; do not reformat whole files.
- Open and confirm commits one at a time.
- Learn message style from the target repository's recent commits.
- Automatically clean only changes that can be classified safely.
- Do not split one file into multiple commits automatically.
- Select validation commands according to the repository and change type.
- Resume the next group on a later invocation rather than keeping a long-running process alive.

## 3. Package Layout

```text
skills/git-commit-assistant/
|- SKILL.md
|- scripts/
|  |- CommitToolkit.ps1
|  `- Test-CommitToolkit.ps1
|- references/
|  `- commit-policy.md
`- evals/
   `- evals.json
```

`SKILL.md` contains the decision workflow and tool invocation contract. `CommitToolkit.ps1` performs deterministic Git inspection, normalization, compact reporting, plan persistence, validation preflight, and TortoiseGit launch. `commit-policy.md` contains detailed boundary and message rules that are only loaded when necessary.

The self-contained test script creates temporary repositories and requires no Pester installation.

## 4. Persistent State

All generated state lives under the target repository's Git directory:

```text
<git-dir>/git-commit-assistant/
|- context.json
|- plan.json
|- state.json
|- message.txt
`- backup/
```

Use `git rev-parse --git-dir` rather than assuming `.git` is a directory. This supports worktrees where `.git` is a file. State never enters the worktree or a commit.

The context records:

- repository root and Git directory;
- base HEAD and branch;
- whether merge, rebase, cherry-pick, revert, or bisect state exists;
- staged, unstaged, untracked, renamed, deleted, submodule, LFS, binary, and conflicted paths;
- file hashes and compact change metadata;
- recent commit-style samples;
- normalization actions and backups;
- validation discovery and results.

The plan records ordered groups. Each group includes a stable ID, intent, paths, message, dependencies, validation commands, state, and the hashes observed when the plan was saved.

## 5. Commands

`CommitToolkit.ps1` exposes explicit actions:

```powershell
CommitToolkit.ps1 -Action Analyze   -Repository <path> [-OutputPath <path>]
CommitToolkit.ps1 -Action Normalize -Repository <path> [-Extensions <list>] [-DryRun]
CommitToolkit.ps1 -Action SavePlan  -Repository <path> -PlanPath <path>
CommitToolkit.ps1 -Action OpenNext  -Repository <path> [-Validation light|auto|full|none] [-DryRun]
CommitToolkit.ps1 -Action Status    -Repository <path>
CommitToolkit.ps1 -Action Clear     -Repository <path>
```

Every action returns a stable JSON envelope on stdout:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "action": "Analyze",
  "summary": {},
  "warnings": [],
  "errors": []
}
```

Human diagnostics go to stderr. Secret values must be redacted from both streams.

## 6. Repository Inspection

Use NUL-delimited Git output where available. Prefer:

- `git status --porcelain=v2 -z`;
- `git diff --numstat -z` and `git diff --name-status -z`;
- `git diff --summary` for mode and rename metadata;
- `git check-attr -z` for text, eol, encoding, generated, linguist, filter, and diff attributes;
- `git log -20` with message and changed-path metadata;
- `git rev-parse` for root, Git directory, branch, and HEAD.

Do not parse localized, human-formatted `git status` output.

Treat submodules and nested repositories as atomic path entries. Do not descend into them unless the user separately invokes the skill in that repository.

## 7. Compact Context and Token Control

The first analysis returns metadata rather than full patches:

- status and path;
- added/deleted line counts;
- hunk count;
- file type, size, binary/generated/LFS flags;
- rename source and destination;
- semantic-change versus whitespace-only classification;
- directory rollups;
- recent message-style features.

The complete manifest is written to `context.json`. Stdout returns bounded summaries and IDs. When grouping remains ambiguous, the skill requests a focused expansion for selected IDs using a small-context patch (normally `--unified=1`) with explicit byte and line limits.

For very large change sets, summarize by directory and extension first, then expand only candidate themes. Do not stream large generated files, binaries, or complete repository diffs into model context.

The performance test compares compact output size with a full patch over synthetic repositories. Compact mode must remain bounded and materially smaller, while retaining enough path metadata to form themes.

## 8. Supported Text Files

The default normalization allowlist is:

```text
.cs .lua .xml .json .jsonc .md .yml .yaml .toml
.ps1 .cmd .sh .js .jsx .ts .tsx .mjs .css .scss
.shader .cginc .hlsl .txt
```

Repository attributes and configuration can narrow or extend this list. Never treat extension alone as proof that a file is safe to decode.

## 9. Safe Diff Normalization

Normalization is transactional and runs before grouping.

### 9.1 Preconditions

- Resolve the repository and base HEAD.
- Refuse conflicted files and active history operations.
- Preserve the Git index exactly; if staged changes exist, stop by default and explain that the user must resolve the staged state manually.
- Skip binary, LFS, submodule, generated, ignored, oversized, invalidly encoded, or ambiguous files.
- Store the original bytes and hash before changing a file.

### 9.2 Policy Sources

Apply formatting policy in this order:

1. `.gitattributes`, including `text`, `eol`, `working-tree-encoding`, filters, and generated markers;
2. applicable `.editorconfig` settings;
3. the base blob's encoding, BOM, final-newline state, and dominant line ending;
4. no automatic change when the preceding sources do not establish a safe choice.

### 9.3 Allowed Changes

- Preserve the original encoding and BOM unless repository policy explicitly requires another encoding.
- Correct mixed line endings or an accidental whole-file LF/CRLF conversion to the established target style.
- For an existing tracked file, generate a zero-context patch and identify independent hunks whose added and removed payload consists only of blank or whitespace-only lines. Reverse only those hunks to the base form.
- Leave a hunk untouched when whitespace noise and semantic changes appear together.
- Remove trailing whitespace only when applicable repository policy explicitly enables `trim_trailing_whitespace`.
- Preserve the base final-newline state for existing files. For new files, apply `insert_final_newline` only when explicitly configured.
- Do not normalize a new file without an explicit repository policy.

### 9.4 Verification and Rollback

After each file:

- decode it again under the same encoding;
- ensure non-whitespace semantic tokens and binary classification did not change unexpectedly;
- confirm the Git index hash is unchanged;
- regenerate the diff;
- record the reduced lines and hunks.

If any assertion fails, restore the original bytes for that file and return a warning. Never partially rewrite a file after an error.

## 10. Commit Grouping

Group by user-visible intent, not file extension. Apply these rules:

- implementation and its tests belong together;
- source and a required generated artifact belong together;
- rename and edits to that renamed file belong together;
- configuration migration and code that requires it belong together;
- documentation follows the related change only when it explains that same behavior;
- independent documentation, cleanup, refactoring, fixes, and features use separate commits;
- dependency order is explicit, with foundational refactoring or configuration before dependent behavior;
- avoid tiny commits that cannot be described as independently useful;
- a file appears in exactly one group, unless it is explicitly deferred with a reason.

Do not split hunks automatically. A file containing multiple themes is marked `mixed`. Place it in the dominant atomic theme only when defensible; otherwise stop and ask the user to reorganize that file before continuing.

## 11. Commit Message Style

Inspect the most recent 20 relevant commits and infer:

- language;
- use of Conventional Commit prefixes;
- scope syntax;
- capitalization and punctuation;
- typical subject length;
- whether bodies are common;
- relationship between changed paths and scopes.

Follow the repository's established style. When evidence is insufficient or inconsistent, fall back to Conventional Commits with a concise Chinese subject.

Messages explain what changed and why. They do not list filenames and do not add AI, Codex, Claude, co-author, or generator attribution.

## 12. Validation

`OpenNext` accepts `light`, `auto`, `full`, or `none`.

Always perform these non-destructive checks unless explicitly disabled:

- unresolved conflicts and conflict markers;
- staged-index safety;
- suspicious credential and private-key patterns, with redacted output;
- path and file-hash drift;
- JSON parsing for changed JSON files;
- secure XML parsing for changed XML files, with external entity resolution disabled;
- `git diff --check` findings, distinguishing pre-existing/upstream formatting from newly introduced errors.

In `auto` mode:

- read applicable `AGENTS.md`, `CLAUDE.md`, README, build files, and existing scripts;
- choose the smallest relevant, local, non-interactive build or test command;
- for C#, prefer repository-documented commands, then an applicable solution/project build;
- for Lua, prefer repository lint/test scripts when already available;
- do not install tools or dependencies;
- do not publish, deploy, migrate, contact services, or run commands requiring credentials;
- report when a useful validator is unavailable rather than improvising an installation.

Validation failure blocks GUI launch. The user may explicitly request proceeding with a documented known failure; that decision is recorded in plan state.

## 13. Safety Stops

Stop before opening TortoiseGit when any of these apply:

- unresolved conflicts;
- merge, rebase, cherry-pick, revert, or bisect in progress;
- detached HEAD;
- staged changes that could escape the selected group;
- credential-like content requiring human review;
- unexpected large files, mass deletion, or mass rename;
- changed paths or hashes after plan creation;
- current HEAD is not the expected plan HEAD or expected descendant;
- a selected path no longer belongs to the working tree change set;
- TortoiseGit is missing;
- the exact path-list command exceeds a conservative Windows command-line limit.

Never replace an exact file selection with a broader directory selection. Never invoke `git reset`, `git clean`, checkout-based discard, stash, commit, push, or force operations.

## 14. TortoiseGit Integration

Resolve `TortoiseGitProc.exe` from `PATH` first, then standard 64-bit and 32-bit installation locations.

For the current group, write a UTF-8 message file and launch:

```text
TortoiseGitProc.exe
  /command:commit
  /path:"<absolute-file-1>*<absolute-file-2>*..."
  /logmsgfile:"<git-dir>\git-commit-assistant\message.txt"
```

Use argument-array process launching rather than composing a shell command string. Windows paths cannot contain `*`, so it is safe as TortoiseGit's documented path separator. Quote and length-check the final arguments.

`-DryRun` returns the executable, argument list, selected path IDs, and redacted message metadata without launching a process.

The tool does not wait for the GUI. On a later invocation, `OpenNext` determines whether the previous group was committed by comparing HEAD advancement, commit paths, remaining working changes, and saved hashes. Cancellation leaves the group pending. Ambiguous results invalidate the plan and require re-analysis.

When all groups are complete, report the resulting commit IDs and remove transient message and backup files. Keep a small final state summary until `Clear` or the next plan.

## 15. Error Contract

Use stable error codes such as:

- `NOT_GIT_REPOSITORY`
- `UNSUPPORTED_GIT_STATE`
- `INDEX_NOT_CLEAN`
- `CONFLICTS_PRESENT`
- `WORKTREE_DRIFT`
- `UNSAFE_NORMALIZATION`
- `SECRET_REVIEW_REQUIRED`
- `VALIDATION_FAILED`
- `TORTOISEGIT_NOT_FOUND`
- `COMMAND_LINE_TOO_LONG`
- `PLAN_INVALID`

Errors include a concise explanation and a safe next action. They never include detected secret values or large file contents.

## 16. Test Strategy

`Test-CommitToolkit.ps1` creates disposable repositories under the system temporary directory and validates:

1. a C# file with whole-file line-ending conversion, a real code edit, and a separate blank-line-only hunk;
2. Lua, XML, and JSON blank-only diffs, mixed hunks, BOM preservation, final newline behavior, and invalid documents;
3. multiple themes containing implementation, tests, documentation, configuration, rename, deletion, and untracked files;
4. a mixed-theme file that must not be hunk-split;
5. Chinese, English, Conventional, and custom recent commit styles;
6. staged changes, conflicts, active operations, secret shapes, large files, LFS pointers, submodules, generated files, and nested worktrees;
7. first-group completion, cancellation, worktree drift, and HEAD drift;
8. exact TortoiseGit path and log-message arguments under `-DryRun`;
9. compact output size against full patches over a large synthetic change set;
10. index hashes before and after every analysis and normalization path.

Tests assert that no commit or push occurs, no index entry changes, normalized semantic content remains stable, selected paths form an exact group, and unsafe inputs stop before GUI launch.

## 17. Skill Evaluation

Initial prompts:

1. `帮我整理这个 Unity 项目的 C#、Lua、XML 改动，拆分后用 TortoiseGit 提交。`
2. `这些改动里有大量换行噪音，只保留有效 diff，按仓库风格准备提交。`
3. `继续上次未完成的提交计划，打开下一组 TortoiseGit 窗口。`

Expected behavior includes using the bundled tool, avoiding full-diff ingestion, reporting normalization, producing defensible file-level groups, respecting validation stops, and handing off the final action to a prefilled TortoiseGit window.

## 18. Acceptance Criteria

- Supported line-ending-only changes disappear without semantic change.
- Independent blank-line-only hunks are reverted; mixed semantic hunks remain untouched.
- Encodings and BOMs remain stable unless explicit policy says otherwise.
- The Git index remains byte-for-byte unchanged throughout preparation.
- Compact analysis avoids loading full repository diffs by default.
- Every included path belongs to exactly one ordered commit group.
- Messages follow recent repository style with a documented fallback.
- Validation is local, proportionate, and non-destructive.
- TortoiseGit opens with exactly the current group's paths and a prefilled message.
- The skill never commits or pushes.
- Resume behavior safely distinguishes completed, cancelled, and drifted plans.
- Automated tests pass on Windows PowerShell 5.1 and PowerShell 7 where available.
