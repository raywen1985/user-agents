# Claude Improve Full Lark CLI Permission

Date: 2026-10-30

## Goal

Allow Claude Code sessions started in `claude-projects/improve` to run every command whose executable is the locally installed `lark-cli.exe` without a Claude shell approval prompt.

This permission intentionally includes commands with external side effects, including sending or replying to messages, uploading files, changing chats, and creating or processing Lark resources. It does not grant every Bash or PowerShell command. Lark authentication, tenant scopes, server-side permissions, and any confirmation implemented by a specific Lark workflow remain in effect.

## Portable Configuration Boundary

The shared project configuration must not contain a drive letter, username, or resolved home path. The existing portable `.claude/settings.json` continues to contain only relative and home-relative paths.

A project installer discovers the executable on each device and writes the required absolute-path permissions to the ignored `.claude/settings.local.json`. It generates both the ordinary form and the MSYS path-conversion-disabled form needed by Lark API commands whose arguments contain slash-prefixed routes:

```text
Bash('<shell-quoted Git-Bash-compatible lark-cli.exe path>' *)
Bash(MSYS_NO_PATHCONV=1 '<shell-quoted Git-Bash-compatible lark-cli.exe path>' *)
```

The trailing wildcard must match both a bare invocation and any argument list. The installer owns only rules that it inserted and recorded in its ignored state file. It preserves all unrelated user permissions and settings. Re-running it with a new executable location removes previously inserted rules and adds missing new rules. If a desired rule already existed before installation, the installer does not adopt it, does not record it as owned, and never removes it during relocation or uninstall. A missing or invalid prior state never authorizes broad deletion from the settings file.

## Executable Discovery And Validation

The installer is a PowerShell entry point located under `claude-projects/improve/scripts/` and resolves paths relative to `$PSScriptRoot`.

Discovery behavior is:

1. an explicit `-LarkCliPath` argument is exclusive and only that candidate is validated;
2. otherwise, collect all known per-user installation locations derived from Windows environment APIs and every application command named `lark-cli.exe` found through `Get-Command`;
3. canonicalize and deduplicate candidates case-insensitively, validate every distinct candidate, and require exactly one valid executable.

The newly selected path must resolve to one regular `.exe` file, must not cross a reparse point, and must pass a read-only `--help` capability probe. Multiple valid candidates across known locations and `PATH` fail and require an explicit path. The installer never downloads or authenticates Lark CLI.

The native Windows path is converted to the slash form Claude's Bash permission matcher sees and then encoded as one POSIX shell argument using single-quote escaping. A literal apostrophe is represented by closing the quote, emitting an escaped apostrophe, and reopening the quote. This prevents expansion of spaces, dollar signs, command substitutions, and backticks while supporting legal Windows path characters. The same quoting function produces the permission rule and the invocation value stored in state. The generated rules match the exact path string with zero or more arguments; they do not match a copied executable at another path, a `PATH` alias, a temporary shell variable, `powershell.exe`, or arbitrary shell commands.

This is path-based authority, not persistent executable identity. Validation proves what occupies the path during installation, but Claude does not hash the executable before each invocation. An upgrade or any later replacement at the same authorized path inherits the full permission without another probe. This is accepted for the requested convenience. Moving to a different path requires re-running the installer; rerunning also revalidates the current file.

## Generated Files And Ownership

The installer manages two ignored files:

```text
claude-projects/improve/.claude/settings.local.json
claude-projects/improve/.claude/lark-cli-permission-state.local.json
claude-projects/improve/.claude/lark-cli-permission-transaction.local.json
```

The root `.gitignore` contains exact entries for the state and transaction files in addition to the existing `settings.local.json` rule. Tests verify all generated files with `git check-ignore` so a machine path cannot be committed accidentally.

The state document has an exact schema: `schemaVersion`, canonical native `resolvedExecutable`, `shellInvocation`, and a string array `insertedRules`. `insertedRules` contains only rules actually inserted by this installer and may be empty when all desired rules pre-existed. The document contains no token, authentication material, command output, or Lark data. Ownership state is valid when every path and rule is canonical output reproduced from `resolvedExecutable` by the current generator. The old recorded executable does not need to exist or pass a live probe, so relocation and uninstall can remove owned stale rules after that file is deleted. Only the newly selected executable is validated live. Unknown keys, wrong types, unsupported versions, duplicate entries, or noncanonical rules fail closed.

Settings validation requires a JSON object. If present, `permissions` must be an object and `permissions.allow` must be an array containing only strings. Any other shape fails before mutation.

Settings update behavior:

- parse the existing file as JSON and require an object;
- create `permissions.allow` only when missing;
- preserve array order and every unrelated entry;
- remove only prior rules listed in a valid state's `insertedRules`;
- add each missing newly generated rule once and record only the entries actually added;
- hold an exclusive named Windows mutex for discovery, recovery, candidate generation, publication, and uninstall without creating a persistent lock file;
- record hashes and existence for settings and state, then recheck them immediately before publication so an external edit aborts without being overwritten;
- validate both serialized candidates before publication;
- use same-directory temporary files, validated backups or absence tombstones, and atomic replacement for each target;
- persist a transaction journal before the first replacement, record the intended settings and state hashes and publication phase, inspect and report it without mutation during `-CheckOnly`, and recover it before install or uninstall;
- after interruption, complete the transaction only when both targets equal their intended hashes, roll back only targets that still equal this transaction's candidate hashes, and fail with `recovery-required` on any third-party content rather than overwriting it;
- remove the journal only after both targets and state are verified as one committed generation.

No change is written when both generated documents already have the expected content.

The mutex serializes this installer but cannot make an arbitrary editor cooperate. Windows does not provide the portable content compare-and-swap needed to combine a hash precondition with atomic path replacement. A non-cooperating process can still write in the narrow interval between the final hash check and replacement. The installer documents that Claude sessions and editors changing this local settings file must be stopped during install or uninstall. It preserves backups and performs post-publication verification, but it cannot recover an edit that another process completed and that atomic replacement fully displaced in that interval. Tests guarantee detection of edits visible by the final pre-publication check and conditional recovery of edits observed after publication; they do not claim to eliminate this operating-system race.

## Invocation Contract

`CLAUDE.md` tells Claude to read the local state file, require the supported schema, and use its `shellInvocation` value verbatim as the executable token. It must invoke that resolved executable directly. It must not use the `PATH` alias or construct commands using a temporary assignment such as `LARK=...; "$LARK" ...`, because Claude permission matching evaluates the written command form and those alternatives do not match the exact executable rule. For commands with slash-prefixed API routes, it prefixes the direct invocation with `MSYS_NO_PATHCONV=1` so the second generated rule applies.

The installer prints the resolved executable, shell invocation, and generated rules after success. Installation documentation gives these commands:

```powershell
./claude-projects/improve/scripts/install-lark-cli-permission.ps1 -CheckOnly
./claude-projects/improve/scripts/install-lark-cli-permission.ps1
```

`-CheckOnly` is strictly read-only. It does not recover transactions, acquire a file-backed lock, create backups, remove journals, or change settings/state. If a transaction journal exists, it reports that install or uninstall recovery is required and exits nonzero. Otherwise it performs discovery and validation and reports the proposed rules. Install and uninstall recover an interrupted transaction before doing new work. An explicit path is available for nonstandard installations.

## Security And Rollback

The broad authority is explicit: after installation, Claude can invoke any current or future `lark-cli` subcommand without a Claude shell approval prompt. A prompt or skill can therefore cause Lark-side changes within the authenticated identity's scopes. Any executable later placed at the authorized path inherits the same authority. This is the requested path-based behavior.

The permission does not approve shell operators or companion commands by itself. In a compound command, Claude still evaluates each other subcommand under its normal rules. Redirection targets retain Claude's file checks. Read-only utilities may already be approved by Claude's built-in policy or existing user rules. The explicit `MSYS_NO_PATHCONV=1` form is part of the granted authority; other environment-prefix forms are not.

Rollback uses an `-Uninstall` switch. It removes only rules in a valid state's `insertedRules`, preserves desired rules that pre-existed installation and every unrelated setting, and removes the state file as the second target of the same journaled transaction. If state is absent or malformed, uninstall fails closed and reports that manual inspection is required.

## Testing And Acceptance

PowerShell tests use temporary project and user directories and a fake regular executable. They do not execute the real authenticated Lark CLI beyond the installer's read-only capability probe.

Tests cover:

- fresh installation creates the two exact permissions and a state document;
- fresh installation with either or both desired rules already present records only newly inserted rules and never adopts user-owned entries;
- existing unrelated settings and allow rules remain byte-equivalent in value and order;
- repeated installation is idempotent;
- executable relocation replaces only previously inserted rules and preserves a pre-existing desired rule at the new path;
- relocation and uninstall remove owned rules when the old executable has already been deleted;
- malformed JSON and every wrong settings/state shape, unsupported version, noncanonical state rule, missing executable, reparse points, failed probe, and cross-tier ambiguous discovery fail without partial writes;
- paths containing spaces, dollar signs, backticks, apostrophes, and parentheses are shell-quoted and converted correctly, with no expansion or command substitution;
- `-CheckOnly` writes nothing with either a clean state or a pending transaction journal, and the latter exits nonzero with recovery guidance;
- `-Uninstall` removes only the owned rule and state;
- a temporary-variable command is not emitted or recommended;
- shared tracked files contain no machine-specific absolute path;
- competing installer runs serialize through the named mutex, and an external settings edit visible at the final pre-publication check aborts without losing that edit;
- the documented non-cooperating-editor race between final comparison and atomic replacement is not misrepresented as content compare-and-swap;
- interruption before and after each settings/state publication and journal phase either completes, conditionally rolls back, or reports `recovery-required` without deleting third-party content;
- `git check-ignore` covers settings, state, transaction journals, backups, locks, and temporary installation artifacts.

An integration matrix against the installed Claude Code permission matcher covers the direct quoted path with zero arguments and with arguments, the `MSYS_NO_PATHCONV=1` direct form, `PATH` alias, temporary-variable indirection, copied executable path, PowerShell wrapping, `;`, `&&`, pipe, redirection, command substitution, and other environment prefixes. Only the two generated executable forms are pre-approved; companion subcommands and file targets follow their own rules.

Acceptance requires the tests to pass, `claude doctor` to report no invalid settings, the local generated rules to point at the current regular `lark-cli.exe`, and a new Claude Code session in the improve project to read `shellInvocation` and run the literal quoted absolute invocation for `--help` and `auth scopes` without a Claude approval prompt. The acceptance test never substitutes the `lark-cli` PATH alias for that literal invocation.
