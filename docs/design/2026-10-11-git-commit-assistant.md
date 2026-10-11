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
|- lock
|- messages/
|  `- <launch-id>.txt
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

State-changing actions acquire an exclusive, worktree-specific lock. JSON state is written to a new file, flushed, and atomically replaced. A normalization journal is flushed before each file write and records the backup path, original hash, and intended result. Startup recovers an interrupted write from that journal before any new operation. `Clear` refuses to remove backups or journals while recovery or a launch confirmation is pending.

## 5. Commands

`CommitToolkit.ps1` exposes explicit actions:

```powershell
CommitToolkit.ps1 -Action Analyze   -Repository <path> [-OutputPath <path>]
CommitToolkit.ps1 -Action Normalize -Repository <path> [-Extensions <list>] [-DryRun]
CommitToolkit.ps1 -Action SavePlan  -Repository <path> -PlanPath <path>
CommitToolkit.ps1 -Action OpenNext  -Repository <path> [-Validation light|auto|full|none] [-ValidationApprovalId <id>] [-DryRun]
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

`SavePlan` accepts only the documented versioned JSON schema. It canonicalizes every path and rejects paths outside the worktree, duplicate or overlapping group membership, paths absent from the captured change set, ignored paths, stale hashes, invalid dependency graphs, directories standing in for file selections, and untracked nested repositories. Symlinks, junctions, and other reparse points are never normalization targets. A tracked submodule gitlink is represented as one atomic path and is not traversed.

## 6. Repository Inspection

Use NUL-delimited Git output where available. Prefer:

- `git status --porcelain=v2 -z`;
- `git diff --numstat -z` and `git diff --name-status -z`;
- `git diff --summary` for mode and rename metadata;
- `git check-attr -z` for text, eol, encoding, generated, linguist, filter, and diff attributes;
- `git log -20` with message and changed-path metadata;
- `git rev-parse` for root, Git directory, branch, and HEAD.

Do not parse localized, human-formatted `git status` output.

Every Git inspection is invoked with optional locking and filesystem monitors disabled (`git --no-optional-locks -c core.fsmonitor=false ...`, and `GIT_OPTIONAL_LOCKS=0` for child processes). Child environments remove fsmonitor-related overrides. Diff-family commands always pass `--no-ext-diff --no-textconv`; child environments remove `GIT_EXTERNAL_DIFF` and related override variables. Analysis reads repository blobs with plumbing commands and worktree files with byte APIs. It never invokes hooks or clean, smudge, process, textconv, external diff, or fsmonitor programs. Resolve the worktree-specific index with `git rev-parse --git-path index`, hash its bytes before and after every action, and fail if the hash changes. Any staged entry is an unconditional stop for `Normalize`, `SavePlan`, and `OpenNext`; this version has no mixed-index workflow.

On Windows PowerShell 5.1 and PowerShell 7, capture native Git stdout as bytes through `System.Diagnostics.Process` redirected base streams, then decode using the explicit encoding required by that command. Do not rely on the host console code page or PowerShell's native pipeline decoding. JSON state is UTF-8 without BOM; TortoiseGit message files are UTF-8 with BOM for compatibility. Tests assert these byte-level contracts on both hosts.

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

Before any patch text is written to disk or emitted to stdout, stderr, logs, or model context, scan it for secret patterns. Added or untracked content can block a commit; all displayed context is redacted. Findings contain only path, line number, rule ID, confidence, and disposition, never the matched value. False positives are waived only by an explicit, hash-bound exception in the plan; a changed line invalidates the exception.

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

The allowlist means "eligible for inspection," not "eligible for every rewrite." Each rewrite also requires a proof adapter for the file type and change shape. Files without an applicable proof adapter are reported and left untouched.

## 9. Safe Diff Normalization

Normalization is transactional and runs before grouping.

### 9.1 Preconditions

- Resolve the repository and base HEAD.
- Refuse conflicted files and active history operations.
- Preserve the Git index exactly; if any staged change exists, stop unconditionally and explain that this version requires a clean index.
- Skip binary, LFS, submodule, generated, ignored, oversized, invalidly encoded, or ambiguous files.
- Store the original bytes and hash before changing a file.

### 9.2 Policy Sources

Apply formatting policy in this order:

1. `.gitattributes`, including `text`, `eol`, `working-tree-encoding`, filters, and generated markers;
2. applicable `.editorconfig` settings;
3. the base blob's encoding, BOM, final-newline state, and dominant line ending;
4. no automatic change when the preceding sources do not establish a safe choice.

### 9.3 Proof Adapters and Allowed Changes

Normalization is conservative and change-local. Preserve encoding and BOM. Never rewrite through a symlink or reparse point. Automatic changes require one of these proofs:

1. **Exact restoration:** if the entire current change is encoding, BOM, line-ending, final-newline, or whitespace noise, restore the tracked file to its exact base bytes. This is always safe because it removes the complete worktree change.
2. **Unchanged-line EOL restoration:** align base and current content by byte-stable non-newline content. Restore the original terminator only on unchanged base lines. Never alter the terminator of a new or edited line under this proof. Format policy alone does not prove that a newline is outside a data-bearing region. Ambiguous alignments are skipped.
3. **Grammar proof:** reverse an independent blank/whitespace-only hunk only when a format-specific adapter proves that every affected byte is grammar trivia outside strings, raw strings, interpolated/template strings, character literals, comments, heredocs, preprocessor/directive-sensitive regions, XML text nodes, and other data-bearing regions. The adapter must produce the same significant token stream before and after and reject lexical errors.
4. **Data-model proof:** JSON may be parsed before and after with duplicate-key detection and compared as an ordered token/value model. XML changes require an explicit repository whitespace policy or schema proving element-only content; absent that evidence, whitespace text nodes are data and are not changed.

The first implementation must provide these adapters and change shapes:

- all tracked regular text files: exact restoration and unchanged-base-line EOL restoration only;
- C#: independent blank-line-only hunks classified as trivia by a conservative lexer; raw, interpolated, verbatim, and ordinary strings, character literals, comments, directives, and lexically invalid regions are skipped;
- Lua: independent blank-line-only hunks classified as trivia by a conservative lexer; quoted strings, all levels of long strings/comments, comments, and lexically invalid regions are skipped;
- JSON: whitespace-only changes accepted only when strict parses with duplicate-key detection produce the same ordered token/value model;
- XML: whitespace-only changes accepted only when a repository-provided schema or explicit path policy proves element-only content; DTDs and mixed/unknown content are skipped.

Other allowlisted formats receive inspection, exact restoration, and unchanged-base-line EOL restoration only in version 1. Markdown trailing spaces and blank lines, shell heredocs, JavaScript/TypeScript templates and ASI-sensitive boundaries, shader preprocessor regions, and all other unrecognized data-bearing regions are mandatory skips.

Trailing whitespace is removed only when repository policy explicitly enables it **and** the applicable proof adapter classifies it as non-data trivia. `trim_trailing_whitespace` alone is not sufficient for Markdown hard breaks or literal content. Preserve the base final-newline state for existing files. For new files, normalize only with explicit repository policy and a successful format proof. Mixed semantic/whitespace hunks and all ambiguous cases remain untouched.

### 9.4 Verification and Rollback

After each file:

- decode it again under the same encoding;
- rerun the applicable proof adapter and require its exact invariant;
- confirm the Git index hash is unchanged;
- regenerate the diff;
- record the reduced lines and hunks.

The transaction boundary is one file. Journal intent before writing, use same-directory atomic replacement, then mark that file complete. If any assertion fails, restore its exact original bytes and return a warning. A later file failure does not roll back already verified files, but the report lists every completed file. Startup recovery restores any file whose journal entry lacks a completion marker. Never partially rewrite a file after an error.

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

The mode controls only optional lint, build, and test depth. `none` skips those optional validators; it does not disable the mandatory safety gate. The following checks always run and cannot be overridden:

- unresolved conflicts and conflict markers;
- staged-index safety;
- suspicious credential and private-key patterns, with redacted output;
- path and file-hash drift;
- JSON parsing for changed JSON files;
- secure XML parsing for changed XML files with `DtdProcessing=Prohibit`, `XmlResolver=$null`, bounded document/entity characters, bounded depth, and a timeout;
- `git diff --check` findings, distinguishing pre-existing/upstream formatting from newly introduced errors.

The credential scan reads all added content and every untracked candidate in the selected group, even when no patch expansion was requested. Oversized or unreadable candidates block rather than bypass scanning. Conflict state, any staged entry, repository-operation state, complete status/path drift, hashes and modes, secret scanning, exact path containment, and command-line safety are mandatory in every mode.

In `auto` mode:

- read applicable `AGENTS.md`, `CLAUDE.md`, README, build files, and existing scripts;
- choose and report the smallest relevant, local, non-interactive build or test command;
- for C#, prefer repository-documented commands, then an applicable solution/project build;
- for Lua, prefer repository lint/test scripts when already available;
- do not install tools or dependencies;
- do not publish, deploy, migrate, contact services, or run commands requiring credentials;
- report when a useful validator is unavailable rather than improvising an installation.

Built-in data checks and Git checks may run automatically. Build files, test runners, package scripts, hooks, and repository executables are untrusted repository code: the tool never runs them without explicit approval in the current invocation. Approval records the exact executable, arguments, working directory, file hash or build-definition hashes, environment policy, and timeout. A modified validator or build definition invalidates approval. Run approved commands with credential-bearing environment variables removed, hooks disabled where applicable, restore/network features disabled when the tool supports it, bounded output, and a timeout. Do not claim that these controls make repository code harmless; they limit exposure and preserve an auditable user decision.

When external validation is proposed, `OpenNext` first returns `VALIDATION_APPROVAL_REQUIRED` with a cryptographically random proposal ID and the complete redacted command contract. The proposal is held in locked transient state, expires after 15 minutes, is single-use, and is bound to repository identity, HEAD, change-set hashes, executable, arguments, working directory, validator/build-definition hashes, environment allowlist, and timeout. Only an explicit rerun with `-ValidationApprovalId <id>` executes it. Saved plans and prior invocations cannot supply or renew approval.

The skill must display that complete redacted command contract to the human and receive an explicit affirmative reply in the current conversation turn before it may pass `-ValidationApprovalId`. Generating a proposal, possessing its ID, a prior approval, or the agent's own decision is never human authorization.

After validation, rerun the complete porcelain-v2 status capture and compare the full path set, status codes, modes, worktree hashes, and index hash with the pre-validation snapshot. This detects modified formerly clean tracked files and newly created untracked files, not only changes within the original group. Any added, removed, or changed entry blocks GUI launch and requires re-analysis. Validation commands may never be inferred as approved merely because they appear in `AGENTS.md`, `CLAUDE.md`, README files, project files, or saved state from a prior invocation.

Validation failure blocks GUI launch. The user may explicitly request proceeding with a documented known failure; that decision is recorded in plan state.

## 13. Safety Stops

Stop before opening TortoiseGit when any of these apply:

- unresolved conflicts;
- merge, rebase, cherry-pick, revert, or bisect in progress;
- detached HEAD;
- any staged change;
- credential-like content requiring human review;
- unexpected large files, mass deletion, or mass rename;
- changed paths or hashes after plan creation;
- current HEAD is neither the expected plan HEAD nor an exact sequence of verified planned-group commits;
- a selected path no longer belongs to the working tree change set;
- TortoiseGit is missing;
- the exact path-list command exceeds a conservative Windows command-line limit.

An advanced HEAD is accepted as completion only when a single unambiguous commit has the saved expected parent and its tree delta has exactly the group's path set, expected post-image blob IDs (including deletion markers), and no extra paths. A sequence may advance only through consecutively verified planned groups. Any unrelated, partial, amended, merged, or otherwise unexplained commit invalidates the plan and requires re-analysis.

Expected post-images include both blob ID and tree mode, so executable-bit, symlink, deletion, and gitlink changes cannot be confused. Version 1 predicts blobs only for regular files governed by Git's built-in text/EOL conversion that the tool can reproduce deterministically. Paths using `filter`, `ident`, LFS, custom clean/process behavior, or unsupported `working-tree-encoding` stop before plan launch; the tool never calls `git hash-object --filters` as a workaround. A future filter-aware path requires separate, current-invocation approval to execute the exact filter and is outside this version.

Never replace an exact file selection with a broader directory selection. Never invoke `git reset`, `git clean`, checkout-based discard, stash, commit, push, or force operations.

## 14. TortoiseGit Integration

Resolve `TortoiseGitProc.exe` from `PATH` first, then standard 64-bit and 32-bit installation locations.

For the current group, write a UTF-8 message file and launch:

```text
TortoiseGitProc.exe
  /command:commit
  /path:<absolute-file-1>*<absolute-file-2>*...
  /logmsgfile:<git-dir>\git-commit-assistant\messages\<launch-id>.txt
```

Use `ProcessStartInfo.ArgumentList` where available. On Windows PowerShell 5.1/.NET Framework, use a dedicated, unit-tested Windows argv quoting function implementing `CommandLineToArgvW` backslash-and-quote rules, never a shell command string. Windows paths cannot contain `*`, so it is safe as TortoiseGit's documented path separator.

The three required logical argv elements contain no syntax quotes: `/command:commit`, `/path:<joined-paths>`, and `/logmsgfile:<message-path>`. Any documented optional switch is another element. `ArgumentList` receives those raw elements. Only the PowerShell 5.1 renderer adds command-line syntax quoting.

Count the complete rendered UTF-16 command line, including executable, switches, quotes, separators, trailing NUL, and message path. Refuse launch above 30,000 UTF-16 code units; never broaden the selection to a directory. Test spaces, Chinese and non-BMP characters, `&()`, embedded trailing backslashes, long paths, deletions, and renames. The supported TortoiseGit version is recorded during `Analyze`; exact checkbox selection is covered by a version-qualified manual integration test because `-DryRun` proves only argv construction.

`-DryRun` returns the executable, argument list, selected path IDs, and redacted message metadata without launching a process.

Before launch, acquire the repository lock, create an immutable per-launch message file, record the TortoiseGit process ID and start time, and atomically move the group to `pending-confirmation`; then release the lock. A second invocation never launches that group while the recorded process is alive. If HEAD and the worktree are unchanged after that process exits, report `confirmation-required`: the user must explicitly mark the dialog cancelled or request a fresh launch. Absence of change is never inferred as cancellation. Exact commit recognition uses the tree-delta rule in Section 13. Ambiguous results invalidate the plan and require re-analysis.

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

1. a C# file with whole-file line-ending conversion, a real code edit, a safe blank-line-only hunk, and skipped hunks inside every sensitive lexical region;
2. Lua safe and sensitive blank-only hunks; XML with element-only policy versus mixed/unknown content and malicious DTD/entity input; JSON equal-model whitespace versus duplicate-key/invalid input; BOM and final-newline behavior;
3. multiple themes containing implementation, tests, documentation, configuration, rename, deletion, and untracked files;
4. a mixed-theme file that must not be hunk-split;
5. Chinese, English, Conventional, and custom recent commit styles;
6. staged changes, conflicts, active operations, secret shapes, large files, LFS pointers, submodules, generated files, and nested worktrees;
7. first-group completion, cancellation, worktree drift, and HEAD drift;
8. exact TortoiseGit path and log-message arguments under `-DryRun`;
9. compact output size against full patches over a large synthetic change set;
10. index hashes before and after every analysis and normalization path.

Tests assert that no commit or push occurs, no index entry changes, normalized semantic content remains stable, selected paths form an exact group, and unsafe inputs stop before GUI launch.

The harness isolates system and global Git configuration, hooks, attributes, `core.autocrlf`, credential helpers, external diff/textconv, and user identity. It disables optional locks and prompts. Separate adversarial tests deliberately configure external diff, textconv, filters, and an fsmonitor sentinel, then assert that `Analyze`, `Normalize`, `SavePlan`, and `OpenNext` execute none of them. Additional cases cover `Validation none` retaining every mandatory safety check, validators creating formerly clean or new paths, crash and concurrent-invocation recovery, corrupt state, malicious or modified validators, redaction before persistence/output, symlinks and reparse points, unborn HEAD, Unicode filenames, exact completion versus unrelated HEAD advancement, and PowerShell 5.1 byte decoding, UTF-8 BOM, and argv quoting.

## 17. Skill Evaluation

Initial prompts:

1. `帮我整理这个 Unity 项目的 C#、Lua、XML 改动，拆分后用 TortoiseGit 提交。`
2. `这些改动里有大量换行噪音，只保留有效 diff，按仓库风格准备提交。`
3. `继续上次未完成的提交计划，打开下一组 TortoiseGit 窗口。`

Expected behavior includes using the bundled tool, avoiding full-diff ingestion, reporting normalization, producing defensible file-level groups, respecting validation stops, and handing off the final action to a prefilled TortoiseGit window.

## 18. Acceptance Criteria

- Supported line-ending-only changes disappear without semantic change.
- Independent blank-line-only hunks with an applicable successful proof are reverted; unsupported, sensitive, mixed, or ambiguous hunks remain byte-identical.
- Encodings and BOMs remain stable unless explicit policy says otherwise.
- The Git index remains byte-for-byte unchanged throughout preparation.
- Every automatic whitespace rewrite is justified by a named proof adapter; unsupported or data-bearing regions remain untouched.
- Compact analysis avoids loading full repository diffs by default.
- Every included path belongs to exactly one ordered commit group.
- Messages follow recent repository style with a documented fallback.
- Validation is local, proportionate, and non-destructive.
- TortoiseGit opens with exactly the current group's paths and a prefilled message.
- The skill never commits or pushes.
- Resume behavior safely distinguishes completed, cancelled, and drifted plans.
- Concurrent launches, interrupted state writes, and recovery preserve a single unambiguous pending group.
- Automated tests pass on Windows PowerShell 5.1 and PowerShell 7 where available.
