# AI Startup Health

This framework performs advisory startup checks for Claude Code CLI, Codex CLI,
and Codex desktop. It covers Token Meter, Feishu notifications, the Feishu
remote-control gateway, Chrome DevTools MCP, the local model proxy, runtime
dependencies, and client configuration integrity.

Client startup is never gated on health work. The installed `SessionStart` hook
uses native asynchronous execution, while a 500 ms in-process guard silently
disables the runner when a client, hook, native helper, or desktop build no
longer matches the installation manifest. A guard failure itself is advisory and
deduplicated to at most one bounded `systemMessage` per 30 minutes. Provider
failures and service-start failures always exit `0` and produce at most one
bounded `systemMessage`.

## Install

Run the read-only preflight first:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\startup-health\Install-StartupHealth.ps1 -Mode Preflight
```

Installation is fail-closed. Every discovered consumer of the shared user hook
files must match `compatibility.json`, including the Codex desktop engine
discovered from the running desktop runtime; the fixed `LarkClaudeGateway` task
must match policy, the gateway must publish `processStartedAt`, registry budgets
must fit, and the pinned JSONC editor dependency must be present. A client
upgrade is not approved merely because its version is newer. Run the async-hook
canary and deliberately update the compatibility matrix first. When the desktop
app is discovered but its engine/app build is not in the matrix, preflight
reports `runtime-version-unapproved` until the canary approves that exact pair.

After a successful preflight, install in warning-only mode:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\startup-health\Install-StartupHealth.ps1 -Mode Install
```

The installer writes resolved machine paths only to the local untracked state
directory under `LocalApplicationData\ai-startup-health`. It edits only the
owned `AIStartupHealthV1` entries and preserves JSONC comments, formatting,
encoding, unrelated hooks, and ACLs.

## Activation

Review and trust the exact Codex hook with `/hooks`. Then start or resume every
installed surface once. A real warning-only invocation records activation
evidence for its exact runtime, manifest generation, and hook projection.

Auto-start remains disabled until all surface evidence is complete:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\startup-health\Enable-StartupHealthAutoStart.ps1
```

Only the fixed `\LarkClaudeGateway` scheduled task can be started. Providers
cannot supply a process path, task name, command, or new policy. Chrome, Chrome
DevTools MCP, the model proxy, notification bootstrap, and all missing packages
remain warning-only.

## Rollback

Return immediately to checks-only mode without removing hooks:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\startup-health\Disable-StartupHealthAutoStart.ps1
```

Create an empty `disabled` file in the local state directory for the highest
priority kill switch. It is checked before manifest access and makes the hook
exit silently.

Full uninstall removes only exact owned hooks:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\startup-health\Uninstall-StartupHealth.ps1
```

The manifest, activation evidence, start-attempt ledger, notification ledger,
snapshots, kill switch, and logs are retained for audit and conservative
reinstallation. No checked feature or scheduled task is removed.

## Runtime Dependencies

Dependency checks consume bounded local executable facts. They never install or
upgrade PowerShell, Node.js, `lark-cli`, Claude, Codex, or provider packages.
Run the relevant explicit feature installer when a dependency is missing.

## Configuration Integrity

The owned hook projection must remain exactly one async command with matcher
`^(startup|resume)$` and timeout `75`. Duplicate JSON properties, duplicate
owned hooks, parser failures, runtime identity drift, and provider digest drift
fail closed. JSON documents are parsed with the duplicate-rejecting parser;
Codex TOML is validated through the installed Codex loader by the
`codex-config-load` diagnostic probe. Re-run the installer only after reviewing
the changed source.

## Task Definition Drift

Any action, arguments, working directory, principal, trigger, run level,
restart policy, enabled state, or execution limit change suppresses gateway
auto-start and reports `policy-task-definition-drift`. Review the task change,
run the gateway's explicit task installer if appropriate, and then re-run the
startup-health preflight.

## Chrome DevTools MCP

The check verifies the pinned local package, lockfile, entry script, client
configuration, optional/non-required status, `--autoConnect`, Chrome presence,
and loopback remote-debugging evidence. It never launches Chrome, enables remote
debugging, invokes an MCP tool, or rewrites MCP configuration.

## Local Model Proxy

Only a sanitized loopback endpoint is retained in provider context. The check
performs one short unauthenticated TCP connection and never sends a model
request or exposes credentials. No auto-start policy exists for the proxy.

## Adding Checks

Add a read-only provider under `checks/`, register it in `checks.json`, define
bounded reason and guidance catalogs, declare clients/scope/dependencies and
budgets, and add contract tests. A new check can reuse an existing engine
context profile through the optional `contextProfile` field; the hook entry
points and runner code do not change. A genuinely new context profile or
auto-start behavior requires explicit engine code and design review.
