# AI Client Startup Health

## Goal

Add one extensible, non-blocking startup health system shared by Claude Code, Codex CLI, and the Codex desktop app. It checks the local features required for the user's AI workflow, starts an already-installed service when that operation is explicitly allowed, and reports concise guidance for conditions that cannot be repaired safely.

The health system must never delay, fail, cancel, or change the exit status of a client startup. A failed check, malformed result, timeout, or failed service start is diagnostic information only.

The initial checks cover:

- per-turn token metering;
- Feishu notification hooks;
- the Feishu remote-control gateway;
- Chrome DevTools MCP;
- the local model proxy;
- shared runtime dependencies;
- client configuration integrity.

Future checks must be addable without changing the hook entry points or the orchestration engine.

## Non-Goals

Startup health does not:

- install software, packages, scheduled tasks, hooks, or MCP servers;
- rewrite missing or drifted Claude, Codex, Feishu, Chrome, or token-meter configuration;
- enable Chrome remote debugging or launch the user's browser;
- send a real Feishu test message;
- kill, restart, or replace an already-running process;
- perform destructive cleanup or repair;
- turn an optional MCP server into a required client dependency;
- validate remote APIs or pricing data on every startup.

Installation and repair remain explicit user actions through existing installers or a future manual doctor command.

## Architecture

The system has four layers:

1. **Client hooks** invoke one portable launcher for Claude and Codex session starts. Hooks match `startup|resume` so a fresh CLI session and a desktop-restored session both participate. They do not match `clear`, `compact`, or `fork`.
2. **The launcher** starts the worker in a hidden detached process and exits successfully without waiting for it. Launch failure is swallowed after a best-effort local diagnostic write. The launcher always exits `0` and emits no blocking decision fields.
3. **The worker** applies a machine-and-user mutex, a global cooldown, provider concurrency limits, timeouts, result normalization, optional service starts, atomic caching, and warning aggregation.
4. **Check providers** are independent scripts registered in a versioned manifest. Each provider supports a read-only check action and may optionally support a narrowly defined start action.

Codex hooks use `async = true`. Claude hooks use the equivalent asynchronous command-hook setting. The detached launcher is retained as a second boundary so an implementation regression in the worker cannot make the hook wait. Hook configuration uses a short timeout as a final guard, but normal launch completion must be substantially faster than that timeout.

Codex command hooks are used instead of MCP tool hooks because Codex can run `SessionStart` before MCP connections are ready. Chrome DevTools MCP readiness is therefore inferred from local configuration and client-visible state, not by requiring an MCP tool call during the hook.

## Files And Ownership

The implementation lives under a new `startup-health/` directory:

```text
startup-health/
  checks.json
  Invoke-StartupHealthHook.ps1
  Invoke-StartupHealthWorker.ps1
  Install-StartupHealth.ps1
  StartupHealth.psm1
  checks/
    config-integrity.ps1
    chrome-devtools-mcp.ps1
    lark-gateway.ps1
    lark-notify.ps1
    model-proxy.ps1
    runtime-dependencies.ps1
    token-meter.ps1
  tests/
    Test-StartupHealth.ps1
```

Runtime state is stored outside the repository under `%LOCALAPPDATA%\ai-startup-health\`:

```text
latest.json
last-notified.json
worker.log
```

Writes use a temporary sibling file followed by an atomic replace. Logs are bounded and contain no prompts, transcript content, commands, environment dumps, tokens, credentials, Feishu message content, or browser page data.

## Registry Schema

`checks.json` is the trusted, versioned registry. Version 1 contains an ordered `checks` array. A representative entry is:

```json
{
  "id": "lark-gateway",
  "title": "Feishu remote gateway",
  "script": "checks/lark-gateway.ps1",
  "clients": ["claude", "codex", "desktop"],
  "enabled": true,
  "canAutoStart": true,
  "checkTimeoutMs": 3000,
  "startTimeoutMs": 3000,
  "cooldownSeconds": 300,
  "dependsOn": ["runtime-dependencies"]
}
```

The engine validates before execution:

- the schema version is supported;
- IDs are unique and use a restricted identifier grammar;
- script paths are relative, canonicalize below `startup-health/checks/`, and resolve to regular files;
- dependency IDs exist and contain no cycles;
- timeouts and cooldowns are within bounded ranges;
- `canAutoStart` is an explicit boolean;
- unknown fields are ignored only when the schema version permits them.

An invalid registry produces one normalized `config-integrity` warning and no provider execution. It never affects client startup.

## Provider Contract

Each provider is launched in its own hidden PowerShell process for fault and timeout isolation. The engine invokes it with `-Action Check` or `-Action Start` and passes only a small generated context file containing non-secret paths and the requesting client name.

Standard output must contain one JSON object:

```json
{
  "schemaVersion": 1,
  "id": "lark-gateway",
  "status": "ok",
  "message": "Gateway listener is ready.",
  "autoStart": "not-needed",
  "details": {
    "listenerReady": true
  }
}
```

Allowed statuses are `ok`, `warn`, and `error`. Allowed `autoStart` values are `not-needed`, `eligible`, `started`, `failed`, and `unsupported`. `details` must be bounded, contain only diagnostic scalars, and is never rendered directly to the client.

The engine owns automatic-start authority. It invokes `-Action Start` only when all of these conditions hold:

- the provider returned `autoStart: eligible`;
- the registry sets `canAutoStart: true`;
- dependencies did not return `error`;
- the per-check cooldown allows an attempt;
- no other worker owns the mutex.

After a successful start action, the engine runs one bounded recheck. Providers cannot install or repair configuration through `-Action Start`. A start action may only start an existing, enabled, already-configured service using its established service manager or scheduled task.

Malformed output, nonzero exit, timeout, or unexpected provider termination becomes an isolated warning. The worker continues with independent providers.

## Scheduling And Non-Blocking Guarantees

Every `startup|resume` hook may launch a worker, but only one worker per Windows user and machine can perform work. A named mutex prevents concurrent Claude, Codex CLI, and desktop launches from duplicating checks or service starts.

The latest completed result has a five-minute default freshness window. When the cache is fresh, a worker skips provider execution and only applies notification deduplication. Providers can declare a longer cooldown but cannot force a shorter global startup interval.

The worker runs up to four independent providers concurrently after their dependencies complete. Each provider has a hard process timeout. The worker has an overall bounded lifetime and terminates remaining providers when that lifetime is exceeded. These limits protect background resources; they are not client-startup deadlines because clients never wait for the worker.

All launcher and worker top-level paths use `try/finally` and force process exit code `0`. Provider status never propagates to the client process. The hooks return no `continue: false`, blocking decision, permission decision, or rewritten input.

## Reporting

Healthy startup is silent. Warnings are summarized into one bounded line, for example:

```text
AI health: token-meter=warn(claude-hook-missing) | lark-notify=warn(bootstrap-last-run-failed) | chrome-devtools=warn(codex-not-configured)
```

The worker emits supported informational hook output after completion. Codex may surface asynchronous hook output at its next safe conversation point. The cache remains the source of truth when a client does not display background output.

Repeated identical warning sets are suppressed for 30 minutes per client. A changed warning set is eligible for immediate display. `latest.json` records the complete normalized results, timestamps, durations, and auto-start outcomes so a future manual status command can show detail without repeating startup work.

Messages state the condition and the existing manual recovery command or documentation path when one is known. They do not claim that a feature was repaired unless the bounded recheck confirms it.

## Initial Providers

### Token Meter

The provider checks that:

- the token-meter scripts and module exist;
- Claude has the owned `Stop` hook and status-line command;
- Codex has the owned `Stop` hook and expected status-line configuration;
- the machine/user data directory exists and is writable;
- invocation markers and the install manifest are parseable.

Missing hooks, status-line configuration, or stale markers produce warnings. The provider never runs the installer or rewrites token history. It cannot auto-start.

### Feishu Notifications

The provider checks the notification script, bridge script, notification JSON, `lark-cli` executable, Claude notification hooks, Codex notification hook, Codex native notification bridge, and `LarkNotifyBootstrap` scheduled-task metadata.

The bootstrap task's missing state, disabled state, or nonzero last result is reported. The provider does not trigger it because the bootstrap can modify client configuration. It cannot auto-start.

### Feishu Remote Gateway

The provider checks that the existing `LarkClaudeGateway` scheduled task is installed and enabled, then evaluates its task state and `run/health.json`. A healthy result requires a live recorded PID, a fresh timestamp, `listenerReady: true`, and `stopping: false`.

If the installed task is enabled but not running and no live healthy gateway exists, the provider returns `eligible`. Its start action calls `Start-ScheduledTask` for that exact task name, then the engine performs a bounded health recheck. A missing or disabled task, a running task with stale health, or conflicting live processes is warning-only. The provider never registers the task, kills a process, or invokes the restart workflow.

### Chrome DevTools MCP

The provider checks:

- the pinned local package and expected entry script;
- package metadata consistency with the repository lockfile;
- Claude user configuration for `chrome-devtools`;
- Codex configuration for `mcp_servers.chrome-devtools`;
- `enabled` is not false and `required` is not true;
- the configured command and arguments point to the pinned local entry script and include `--autoConnect`;
- Chrome is present when a local process check is possible.

The MCP process is client-owned and starts as part of client MCP initialization, so this provider does not launch a duplicate server. Missing configuration, disabled remote debugging, initialization failure reported in available local client state, or an unavailable Chrome instance produces a textual warning. The provider never launches Chrome, changes browser flags, opens `chrome://inspect`, or alters MCP configuration. It cannot auto-start.

### Local Model Proxy

The provider extracts the configured loopback provider endpoint without exposing credentials and performs a short TCP connect check. No authenticated model request is sent. Because no trusted service manager for the proxy is currently configured, an unavailable endpoint produces a warning and cannot auto-start.

### Runtime Dependencies

The provider checks the exact executables required by the configured features, including Windows PowerShell, Node.js, `lark-cli`, and relevant client executables. It checks existence and basic version output only from local installed binaries. Missing dependencies are warning-only and are never installed automatically.

### Configuration Integrity

The provider parses the relevant JSON and TOML files, detects duplicate owned hooks, validates owned script paths, and reports configuration drift. It does not normalize or rewrite files. Secret values are neither returned nor logged.

## Client Installation

`Install-StartupHealth.ps1` is an explicit, idempotent installer. It:

1. validates all source scripts and the registry;
2. loads the current Claude and Codex configuration without discarding unrelated user entries;
3. creates timestamped backups;
4. adds one owned `SessionStart` matcher for `startup|resume` to each client;
5. sets the command hook to asynchronous execution with a short timeout;
6. validates candidate JSON and TOML before atomic replacement;
7. reports that Codex may require hook trust review.

Re-running the installer updates only the owned hook definition. It never installs or repairs any checked feature. An uninstaller removes only the exact owned hook and preserves runtime health history.

Codex CLI, the Codex desktop app, and the IDE extension share the same user MCP and hook configuration on the same Codex host. No MCP server is marked `required`, so an optional integration failure cannot fail Codex startup.

## Security Boundaries

- The registry and provider directory are treated as executable configuration and must remain user-controlled local files.
- Provider paths cannot escape the owned checks directory through relative paths, links, or alternate data streams.
- Automatic starts use a closed allowlist. Version 1 permits only the existing `LarkClaudeGateway` scheduled task.
- No provider accepts a command path, task name, script path, or start instruction from hook input.
- Hook input is used only to identify the requesting client and session source after strict parsing.
- Health output excludes secrets, environment values, prompts, transcripts, Feishu identifiers, browser URLs, and file contents.
- A check cannot grant permissions, answer an approval request, or change a client's sandbox mode.

## Testing

Automated tests must cover:

- manifest schema validation, duplicate IDs, invalid paths, links, cycles, unknown dependencies, and bounded numeric fields;
- adding a fixture provider through the registry without changing engine code;
- launcher completion and exit `0` when the worker is missing, malformed, or cannot start;
- worker exit `0` for provider errors, timeouts, malformed JSON, registry errors, cache errors, and start failures;
- mutex and cooldown behavior across concurrent Claude, Codex CLI, and desktop invocations;
- dependency ordering and a four-provider concurrency limit;
- atomic cache writes and recovery from a corrupt previous cache;
- identical-warning suppression and immediate reporting for changed warning sets;
- strict enforcement that only `canAutoStart` providers can receive `-Action Start`;
- successful gateway scheduled-task start followed by a health recheck;
- missing, disabled, running-but-stale, and conflicting gateway states remaining warning-only;
- notification bootstrap failure never triggering the bootstrap task;
- token-meter drift never invoking its installer or repair script;
- Chrome DevTools MCP checks for pinned version, local paths, `--autoConnect`, optional status, and missing client configuration;
- Chrome, remote-debugging, MCP, proxy, dependency, and configuration failures remaining warning-only;
- client hook installation preserving unrelated hooks and creating valid JSON/TOML;
- `startup|resume` matching while `clear|compact|fork` do not trigger the worker;
- no hook or provider result can emit a blocking decision or nonzero client-facing exit status;
- bounded logs and results never contain fixture secrets, prompts, transcript text, Feishu identifiers, or browser URLs.

Manual acceptance verifies that Claude Code, Codex CLI, and the Codex desktop app become usable immediately while a deliberately stopped installed gateway starts in the background, and that a non-repairable failure produces one concise advisory without preventing normal work.

## Rollout And Rollback

Rollout first installs and validates the health scripts, then installs the two user-level hooks. The first run uses all providers in warning-only mode except the closed `LarkClaudeGateway` auto-start action. Existing feature installers and scheduled tasks remain unchanged.

Rollback runs the health-hook uninstaller and removes only the owned Claude and Codex `SessionStart` entries. It does not stop any service, remove checked features, restore unrelated configuration, or delete health history.

