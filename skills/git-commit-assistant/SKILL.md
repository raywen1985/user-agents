---
name: git-commit-assistant
description: Prepare small, reviewable Git commits on Windows with fast bounded analysis, optional conservative diff-noise cleanup, repository-style commit messages, local validation, and exact TortoiseGit file selection. Use whenever the user asks to clean noisy C#/Lua/XML/JSON or other text diffs, split working-tree changes into commits, preserve original diffs while preparing commits, follow recent commit style, continue a saved commit plan, or open a prefilled TortoiseGit commit window. Never commit or push automatically.
compatibility: Windows PowerShell 5.1 or PowerShell 7, Git, and TortoiseGit for GUI launch.
---

# Git Commit Assistant

Prepare commits while leaving the final checkbox review and commit action to the user in TortoiseGit.

## Hard boundaries

- Never run `git commit`, `git push`, reset, clean, checkout-discard, stash, deployment, migrations, or dependency installation.
- Never modify the Git index. Stop when anything is staged.
- Never broaden an exact file list to a directory.
- Never expose secret matches. Report only path, line, rule ID, confidence, and disposition.
- Never execute repository scripts, builds, tests, hooks, filters, or other repository code without the user's explicit approval in the current conversation.
- Open at most one TortoiseGit commit dialog per invocation.

## Tool

Resolve this skill directory, then invoke:

```powershell
& "<skill-dir>\scripts\CommitToolkit.ps1" -Action <action> -Repository <repo>
```

The tool writes one JSON envelope to stdout and diagnostics to stderr. Prefer PowerShell 7 when available; Windows PowerShell 5.1 is supported.

Read [commit-policy.md](references/commit-policy.md) before producing a plan or interpreting a safety stop.

## Workflow

### 1. Resume before analyzing

Run `Status`. If a plan exists:

- If a TortoiseGit process is active, report that the current group is still open and stop.
- If the prior process exited with unchanged HEAD/worktree, ask whether the user cancelled it. Only after an explicit answer may you rerun `OpenNext -ConfirmCancelled`.
- If the previous group was committed exactly, let `OpenNext` verify it and advance.
- If state is drifted or ambiguous, explain the reason and start a fresh `Analyze`; do not guess.

### 2. Analyze compactly

Run:

```powershell
CommitToolkit.ps1 -Action Analyze -Repository <repo>
```

Use the returned file metadata, directory rollups, recent commit subjects, and style features. Do not request, load, or emit raw patch text during commit preparation. If a file remains ambiguous from the bounded manifest, mark it mixed and ask the user to reorganize it or identify its intent.

If the tool reports staged changes, conflicts, an active history operation, detached HEAD, unsafe attributes, secrets, or a nested repository, stop and give the safe next action.

### 3. Choose normalization mode

Normalization is disabled by default. Decide the mode from the user's current request without adding a clarification round trip:

- Explicit cleanup of whitespace, blank lines, EOLs, BOMs, encoding noise, or other invalid diff noise: `normalization: enabled (user requested)`.
- Explicit preservation of the original diff or request to skip cleanup: `normalization: disabled (user requested)`.
- Ordinary or ambiguous commit preparation: `normalization: disabled (default)`.

When disabled, do not invoke or recommend `Normalize`; continue directly to grouping with the original worktree bytes.

When enabled, run `Normalize` before grouping. First use `-DryRun` when the repository is unfamiliar or the change set is large. Report which files would change or changed, the proof adapter, removed lines/hunks, and every skipped file with its reason. An extension is only inspection eligibility, not proof that rewriting is safe. Run `Analyze` again after a real normalization.

Never run `Normalize` while a saved plan exists. Finish or explicitly clear that plan first.

### 4. Form file-level groups

Group by user-visible intent:

- implementation and its tests together;
- configuration/migration before dependent behavior;
- related generated artifacts with their source;
- independent docs, cleanup, refactor, fix, and feature work separately;
- one file in exactly one group.

Do not split a file by hunk. Mark a multi-theme file as mixed and ask the user to reorganize it unless one atomic dominant group is clearly defensible.

Order groups by dependency. Avoid tiny commits that are not independently useful.

### 5. Match message style

Infer style from the latest 20 returned subjects:

- language;
- Conventional Commit prefix and scope usage;
- capitalization, punctuation, and typical length;
- whether bodies are common.

Follow the dominant recent style. If evidence is inconsistent, use a concise Chinese Conventional Commit subject. Do not add AI, Codex, Claude, generator, or co-author attribution.

### 6. Save the plan

Write a temporary JSON plan with this shape:

```json
{
  "schemaVersion": 1,
  "baseHead": "<Analyze head>",
  "groups": [
    {
      "id": "short-stable-id",
      "intent": "one independently useful change",
      "paths": ["repo/relative/path"],
      "message": "message matching repository style",
      "dependencies": [],
      "validation": "auto"
    }
  ]
}
```

Then run `SavePlan -PlanPath <temp-plan>`. The tool rejects overlap, path escape, stale hashes, absent paths, dependency cycles, and unsupported Git attributes.

### 7. Validate and open one group

Run `OpenNext`. Modes affect optional validation only; conflict, index, drift, secret, JSON/XML, path, and command-line checks always run.

If the tool returns `VALIDATION_APPROVAL_REQUIRED`:

1. Show the user the complete redacted executable, argument list, working directory, environment policy, and timeout.
2. Ask for explicit approval in the current conversation.
3. Only after an affirmative answer, rerun with the returned `-ValidationApprovalId`.

Do not approve on the user's behalf. A prior approval does not carry forward.

On success, tell the user which group and exact files were opened. The user reviews checkboxes and clicks Commit in TortoiseGit.

### 8. Continue later

On the next invocation, start again with `Status`, then `OpenNext`. The tool verifies completion from exact parent, path set, blob IDs, and tree modes. When all groups complete, report the resulting commit IDs. Push only if the user separately requests it; this skill itself never pushes.

## Output style

Keep reports compact:

- one exact normalization mode line;
- proof and skip details only when normalization is enabled;
- ordered groups with messages and file counts;
- validation result or exact approval request;
- current TortoiseGit group;
- safe next action.

Do not request or paste raw patches as part of this workflow. The toolkit's bounded manifest and later mandatory validation are the supported analysis channels.
