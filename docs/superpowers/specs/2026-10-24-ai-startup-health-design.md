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

The system has three layers:

1. **Client hooks** invoke one portable health runner for Claude and Codex session starts. Hooks match `startup|resume` so a fresh CLI session and a desktop-restored session both participate. They do not match `clear`, `compact`, or `fork`.
2. **The health runner** remains the client-owned asynchronous hook process. It applies a cross-session user lock, global cooldown, provider concurrency limits, timeouts, result normalization, the closed service-start policy, atomic caching, and warning aggregation.
3. **Check providers** are independent scripts registered in a versioned manifest and required by contract to perform read-only checks. Providers report facts and start eligibility but never receive framework authority to start a process, task, or service.

Codex hooks and Claude hooks both use their native `async = true` command-hook setting. The runner does not detach another process, so its bounded stdout remains attached to the hook host and can be delivered through the client's documented asynchronous hook-output path. The client continues startup without waiting for the runner. Stdin, stdout, and stderr are never inherited by provider descendants.

Version 1 is installed only when all applicable clients satisfy the tested compatibility baseline: Claude Code `2.1.252` or later, Codex CLI `0.163.0-alpha.10.2` or later, and Codex desktop build `26.1013.40934` or later. The installer also validates candidate hook configuration through each available client's configuration-validation path. An older, unknown, or non-validating client is left unchanged and receives an installer-time compatibility message. The installer never falls back to a synchronous hook.

Codex command hooks are used instead of MCP tool hooks because Codex can run `SessionStart` before MCP connections are ready. Chrome DevTools MCP readiness is therefore inferred from local configuration and client-visible state, not by requiring an MCP tool call during the hook.

## Files And Ownership

The implementation lives under a new `startup-health/` directory:

```text
startup-health/
  checks.json
  Invoke-StartupHealthHook.ps1
  Install-StartupHealth.ps1
  Uninstall-StartupHealth.ps1
  Enable-StartupHealthAutoStart.ps1
  StartupHealth.psm1
  tools/
    config-editor.mjs
    package.json
    package-lock.json
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
start-attempts.json
mode.json
install-manifest.json
disabled
runner.log
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
  "scope": "global",
  "enabled": true,
  "autoStartPolicy": "lark-gateway-task-v1",
  "checkTimeoutMs": 3000,
  "cooldownSeconds": 300,
  "dependsOn": ["runtime-dependencies"]
}
```

The engine validates before execution:

- the schema version is supported;
- IDs are unique and use a restricted identifier grammar;
- script paths are relative, canonicalize below `startup-health/checks/`, and resolve to regular files;
- dependency IDs exist and contain no cycles;
- `scope` is `global` or `surface`, and surface-scoped checks declare at least one supported client;
- timeouts and cooldowns are within bounded ranges;
- `autoStartPolicy` is either null or one of the engine's compiled policy IDs;
- optional diagnostic probes use only supported read-only probe types, bounded arguments, and canonical local executables approved during installation;
- each check's reason and guidance catalog contains only bounded static text and allowlisted repository-relative documentation paths or fixed local recovery commands, with no interpolation fields;
- unknown fields are ignored only when the schema version permits them.

The registry contains the declarative reason and guidance catalog for each check, so a newly installed read-only provider can add its own bounded messages without an engine change. The installer validates and hashes the complete registry into `install-manifest.json`; the runner refuses registry drift. An invalid or drifted registry produces one built-in `config-integrity` warning and no provider execution. It never affects client startup.

## Provider Contract

Each provider is launched in its own hidden PowerShell process for fault and timeout isolation. The engine invokes it only with `-Action Check` and passes a small generated context file containing non-secret paths, one explicit surface name, and results from any declared diagnostic probes. Providers follow a read-only contract and cannot request arbitrary engine commands or directly start child processes.

Providers are trusted local executable code running with the same Windows user authority as the runner; they are not an OS sandbox or a security boundary against malicious same-user code. The closed engine policy guarantees that provider *results and registry data* cannot expand framework-controlled auto-start authority. The explicit installer records the registry digest and each approved provider's canonical path and SHA-256 digest in the ACL-protected `install-manifest.json`; the runner refuses a missing, linked, alternate-stream, path-drifted, or digest-drifted provider until an explicit reinstall approves it. Shipped providers are also parsed with the PowerShell AST during installation and tests reject mutating cmdlets, assignment to external files, direct process/service/task start operations, package installers, and dynamic invocation. These controls detect accidental or repository drift; they do not claim containment after compromise of the user's account or trusted files.

External version or client-validation commands run only through an engine-owned diagnostic-probe broker before provider launch. A command probe is a registry declaration, not provider output. During explicit installation the broker resolves its executable to a canonical regular file, rejects links and alternate streams, records the executable digest plus exact argument vector in `install-manifest.json`, and rejects shell strings, metacharacter interpretation, inherited stdin, configurable working directories, and arguments sourced from runtime configuration. At runtime it revalidates that identity, launches the exact argument vector without a shell in a kill-on-close Job Object, and returns only bounded normalized facts. Version checks use a built-in `version-output` probe profile; JSON validation uses the fixed pinned-parser profile; Codex configuration validation uses a fixed `codex-config-validation` profile. Adding a check can compose existing probe profiles without changing the engine; a genuinely new probe capability requires an explicit engine and security-policy change.

The engine creates every provider process inside a Windows Job Object configured with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Timeout, cancellation, or runner exit closes the job and terminates the provider's complete descendant process tree. Stdout and stderr are drained concurrently as UTF-8, each capped at 64 KiB; excess output is discarded and recorded as a bounded protocol error. All process, pipe, and job handles are closed in `finally` paths.

Standard output must contain one JSON object:

```json
{
  "schemaVersion": 1,
  "id": "lark-gateway",
  "surface": "global",
  "status": "ok",
  "reasonCode": "listener-ready",
  "guidanceId": null,
  "startEligibility": "not-needed",
  "facts": {
    "listenerReady": true
  }
}
```

Allowed statuses are `ok`, `warn`, and `error`. Allowed `startEligibility` values are `not-needed`, `eligible`, and `unsupported`. `reasonCode` and `guidanceId` use restricted identifiers and must exist in that check's installed, validated registry catalog or the engine's built-in protocol-failure catalog. The returned `id` and `surface` must exactly equal the invocation. `facts` is limited to 16 keys, scalar values, 256 bytes per string, and 4 KiB total. Provider free-form text is rejected and never flows directly to logs or client output.

A global provider runs once with `surface: global`. A surface-scoped provider runs once for each declared surface and produces a separate normalized result for `claude`, `codex`, and/or `desktop`. The snapshot stores results as a provider-by-surface matrix. Dependencies resolve to the same surface when both providers are surface-scoped; a surface-scoped provider may depend on a global result, while a global provider cannot depend on a surface-scoped result. Auto-start policy is permitted only on global providers, and one policy ID can produce at most one start attempt per completed snapshot.

Provider execution outcome is tracked separately as `completed`, `timed-out`, `protocol-error`, `process-error`, `disabled`, `client-filtered`, or `dependency-skipped`. A health status is accepted only from a `completed` provider. Every result also declares `dependencyReady`; automatic start requires each dependency to have outcome `completed` and `dependencyReady: true`. Disabled, filtered, skipped, timed-out, or malformed dependencies always suppress automatic start.

The engine owns all automatic-start authority. In version 1 its compiled policy table contains exactly one entry:

```text
lark-gateway-task-v1 -> Start-ScheduledTask -TaskPath \ -TaskName LarkClaudeGateway
```

The exact task path, task name, and operation are constants in the engine and cannot be supplied or changed by the registry, provider output, hook input, or context file. Before invocation, the engine compares the live task definition with the complete expected definition captured in the explicit installation manifest: exactly one action; canonical Node executable; exact quoted `src\gateway.mjs` argument; canonical `lark-claude` working directory; current user SID; interactive logon; limited run level; enabled state; zero execution limit; exact restart count/interval; and the exact expected trigger and action sets with no additional entries. Any ambiguity, task-path mismatch, principal mismatch, or definition drift suppresses start. Adding a future read-only check requires only a registry entry and provider. Adding or changing automatic-start authority requires an explicit engine policy change and dedicated security tests.

The engine considers its fixed start action only when all of these conditions hold:

- `mode.json` was successfully parsed at its supported schema version and `autoStart` is exactly `enabled`;
- the provider returned `startEligibility: eligible` with the expected reason code;
- the registry selects the matching compiled policy ID;
- every dependency completed successfully and returned `dependencyReady: true`;
- the per-check cooldown allows an attempt;
- the engine owns the cross-session lock;
- the engine has re-queried the exact scheduled task and the policy's preconditions still hold.

Before invoking the task, the engine atomically persists the attempt timestamp and policy ID to `start-attempts.json`. It then launches an engine-owned helper whose code contains the same fixed task path and name, inside a kill-on-close Job Object with a three-second invocation timeout and bounded output. The helper accepts no task parameters. A successful invocation begins a separate readiness phase that polls provider health for up to ten seconds; this readiness timeout is not part of the invocation timeout. A start action can only start the existing, enabled, definition-matched task named by compiled policy.

Malformed output, nonzero exit, timeout, or unexpected provider termination becomes an isolated warning. The runner continues with independent providers.

## Scheduling And Non-Blocking Guarantees

Every `startup|resume` hook may launch a runner, but only one runner for the Windows user can perform work across local and remote desktop sessions. The runner uses `Global\AIStartupHealth-<SHA256(user-SID)>`, with an ACL granting synchronization rights only to the current SID and `SYSTEM`. It attempts acquisition with zero wait. If the lock is owned, the new runner exits `0` silently without reading cache or updating notification state; it never waits for the owner.

After acquiring the lock, the runner re-reads all cache and cooldown files before making any decision. An abandoned mutex is accepted as ownership, recorded as a bounded diagnostic fact, and followed by normal state revalidation. Missing, corrupt, future-dated, or clock-skewed freshness data is treated as stale. On first installation, the installer creates a valid empty start-attempt ledger. If that ledger is later missing or corrupt, the runner suppresses automatic start for the current run, quarantines a corrupt file with a timestamped name, and atomically creates a valid empty ledger under the lock; the next run may auto-start after normal checks.

Every completed snapshot evaluates every global provider once and every enabled surface-scoped provider once per declared client, regardless of which client invoked the runner. Presentation selects the global results plus the requesting surface's results, so a Claude-triggered snapshot cannot suppress a needed Codex or desktop check. The latest completed result has a five-minute default freshness window. When the cache is fresh, a runner skips provider execution and only applies per-client notification deduplication. Provider-check freshness and service-start cooldown are stored and evaluated independently.

The runner runs up to four independent providers concurrently after their dependencies complete. Each provider has a hard process-tree timeout. The runner has an overall 30-second lifetime and closes all remaining provider Job Objects when that lifetime is exceeded. These limits protect background resources; they are not client-startup deadlines because clients do not wait for an asynchronous hook.

All runner top-level paths use `try/finally` and force process exit code `0`. Provider status never propagates to the client process. The hooks return no `continue: false`, blocking decision, permission decision, or rewritten input. A `disabled` marker checked before registry loading is a local kill switch: when present, the runner exits `0` silently without starting providers or services.

`mode.json` controls automatic start independently from health checking. Its version-1 schema is `{ "schemaVersion": 1, "autoStart": "warn-only" | "enabled" }`. A fresh installation initializes it to `warn-only`; an update preserves a valid existing mode and otherwise resets it to `warn-only`. A missing, unreadable, malformed, unsupported, or unknown mode fails closed to `warn-only`, emits only a bounded diagnostic after checks run, and never prevents health reporting. `Enable-StartupHealthAutoStart.ps1` is the sole supported transition to `enabled`; it validates the installed manifest and fixed gateway policy, then atomically replaces the mode file. The kill switch takes precedence over both modes.

## Reporting

Healthy startup is silent. Warnings are summarized into one bounded line, for example:

```text
AI health: token-meter=warn(claude-hook-missing) | lark-notify=warn(bootstrap-last-run-failed) | chrome-devtools=warn(codex-not-configured)
```

The runner emits one bounded, engine-rendered informational hook result after completion while it still owns the hook's stdout. Codex may surface asynchronous hook output at its next safe conversation point. The cache remains the source of truth when a client does not display background output.

Repeated identical warning sets are suppressed for 30 minutes per client. A changed warning set is eligible for immediate display. `latest.json` records the complete normalized results, timestamps, durations, and auto-start outcomes so a future manual status command can show detail without repeating startup work.

Messages are rendered only from either the engine's small built-in failure catalog or the installed registry's validated, digest-pinned per-check `reasonCode` and `guidanceId` catalog. They state the condition and an allowlisted manual recovery command or repository-relative documentation path when one is known. Provider strings, paths, and facts are not interpolated into client output. Messages do not claim that a feature was repaired unless the bounded recheck confirms it.

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

The bootstrap task's missing or disabled state is reported. `LastTaskResult` is interpreted only after a completed run; while the task is `Running` or `Queued`, running-state codes such as `0x41301` are not treated as failures. Other nonzero completed results are rendered as bounded hexadecimal diagnostic codes. The provider does not trigger the task because the bootstrap can modify client configuration. It has no auto-start policy.

### Feishu Remote Gateway

The provider checks that the existing `LarkClaudeGateway` scheduled task is installed and enabled, then evaluates its task state and `run/health.json`. A healthy result requires `updatedAt` no more than 30 seconds old with five seconds of future-clock tolerance, `listenerReady: true`, and `stopping: false`. The recorded PID must identify a live process whose canonical executable equals the configured Node executable and whose process start time matches `startedAt` within five seconds. Access-denied, malformed, or ACL/read failures are warnings and never start-eligible.

Task state is mapped exactly:

- `Running` or `Queued`: never start; report healthy only when validated health is fresh, otherwise warn;
- `Ready`: return `eligible` only when there is no validated live healthy gateway;
- `Disabled`: warn and do not start;
- missing, unknown, or transient states: warn and do not start.

Immediately before auto-start, the engine re-queries the task and proceeds only if it is still exactly `Ready`, enabled, and has no validated live gateway. The fixed engine policy uses its bounded helper to call `Start-ScheduledTask -TaskPath \ -TaskName LarkClaudeGateway`, then independently polls health every 250 milliseconds for at most 10 seconds. Failure to reach validated health is a warning. Neither provider nor engine registers the task, kills a process, or invokes the restart workflow.

### Chrome DevTools MCP

The provider checks:

- the pinned local package and expected entry script;
- package metadata consistency with the repository lockfile;
- Claude user configuration for `chrome-devtools`;
- Codex configuration for `mcp_servers.chrome-devtools`;
- `enabled` is not false and `required` is not true;
- the configured command and arguments point to the pinned local entry script and include `--autoConnect`;
- Chrome is present when a local process check is possible.

The MCP process is client-owned and starts as part of client MCP initialization, so this provider does not launch a duplicate server. Missing configuration, disabled remote debugging, initialization failure reported in available local client state, or an unavailable Chrome instance produces a textual warning. The provider never launches Chrome, changes browser flags, opens `chrome://inspect`, or alters MCP configuration. It has no auto-start policy.

### Local Model Proxy

The provider extracts the configured loopback provider endpoint without exposing credentials and performs a short TCP connect check. No authenticated model request is sent. Because no trusted service manager for the proxy is currently configured, an unavailable endpoint produces a warning and has no auto-start policy.

### Runtime Dependencies

The provider checks the exact executables required by the configured features, including Windows PowerShell, Node.js, `lark-cli`, and relevant client executables. It reads existence and file metadata directly and consumes bounded version facts produced by declared `version-output` diagnostic probes; it does not invoke the binaries itself. It returns `dependencyReady: false` for a missing executable required by another provider. Missing dependencies are warning-only and are never installed automatically.

### Configuration Integrity

The broker's fixed pinned-parser profile parses relevant JSON through the same `jsonc-parser` used by the config editor so duplicate properties are rejected before deserialization. The fixed `codex-config-validation` profile validates Codex TOML through the installed Codex configuration loader and reads MCP state through the Codex MCP configuration command rather than an ad hoc TOML parser. The provider consumes those normalized validation facts, detects duplicate owned hooks, validates owned script paths, and reports configuration drift. An unavailable client validator becomes a warning. Neither broker nor provider normalizes or rewrites files. Secret values are neither returned nor logged.

## Client Installation

`Install-StartupHealth.ps1` is an explicit, idempotent installer. JSON edits are delegated to `tools/config-editor.mjs`, which runs on the configured local Node runtime with a repository-pinned `jsonc-parser`. The editor rejects duplicate properties, preserves comments, indentation, newline style, final-newline state, and encoding, and performs targeted edits without reserializing unrelated configuration.

The installer:

1. validates all source scripts and the registry;
2. verifies the minimum client versions and async-hook capability gates;
3. loads the current Claude `settings.json` and Codex `hooks.json` without discarding unrelated user entries;
4. records source hashes and, for each existing target, its file identity, ACL, encoding, and timestamped backup; a missing target is recorded as an explicit absent-file identity together with its parent-directory identity and inherited ACL;
5. stages both candidate files and adds one owned `SessionStart` matcher for `startup|resume` to each client;
6. sets the command hook to asynchronous execution with a short timeout;
7. validates both candidates with the JSON parser and available client configuration validators;
8. acquires the installer coordination lock, reopens each existing target with a Windows handle that denies concurrent write sharing, and rechecks its file identity and original hash immediately before replacement; for an absent target, it rechecks that the same parent directory exists and the target is still absent;
9. atomically replaces existing files with `ReplaceFileW`, preserving their original ACLs; for an absent target, it stages a same-directory candidate with the parent's inherited ACL and uses a no-replace atomic `MoveFileExW`, treating an already-created destination as a conflict; it records each exact installed identity and hash;
10. if the second operation fails, restores a replaced first file only when its current identity and hash still equal the just-installed candidate; if the installer created the first file, it removes that file only under the same identity-and-hash guard; if another process changed or replaced it, the installer preserves that change and reports manual recovery instead of overwriting or deleting it;
11. verifies both final hashes before releasing the coordination lock, retaining all backups on mismatch or rollback failure;
12. reports that Codex may require hook trust review.

The owned-hook identity is the normalized absolute command path to `Invoke-StartupHealthHook.ps1`, the exact owner argument `-Owner AIStartupHealthV1`, and the matcher `^(startup|resume)$`. Update and uninstall operations touch only a handler with that complete identity. A similar command, a different owner argument, or a user-modified matcher is reported for manual review rather than removed.

Re-running the installer updates only the owned hook definition. It never installs or repairs any checked feature. An uninstaller removes only the exact owned hook and preserves runtime health history.

Codex CLI, the Codex desktop app, and the IDE extension share the same user MCP and hook configuration on the same Codex host. No MCP server is marked `required`, so an optional integration failure cannot fail Codex startup.

## Security Boundaries

- The registry and provider directory are trusted executable configuration with the same authority as the Windows user; they are not a sandbox boundary. Installation records their approved digests and runtime refuses drift.
- Provider paths cannot escape the owned checks directory through relative paths, links, or alternate data streams.
- Shipped providers obey a tested read-only contract. Within the health framework, provider output and registry data cannot expand the engine's compiled start-policy table; version 1 contains only the exact definition-matched `\LarkClaudeGateway` scheduled task. Malicious same-user modification of trusted executable files is outside this guarantee.
- No provider accepts a command path, task name, script path, or start instruction from hook input, registry fields, or context files.
- Hook input is used only to identify the requesting client and session source after strict parsing.
- Health output excludes secrets, environment values, prompts, transcripts, Feishu identifiers, browser URLs, and file contents.
- A check cannot grant permissions, answer an approval request, or change a client's sandbox mode.

## Testing

Automated tests must cover:

- manifest schema validation, duplicate IDs, invalid paths, links, cycles, unknown dependencies, unknown auto-start policy IDs, and bounded numeric fields;
- `install-manifest.json` verification of the registry digest, provider canonical paths and SHA-256 digests, and diagnostic-probe executable identity, digest, and exact argument vectors, including refusal of missing, linked, alternate-stream, path-drifted, and digest-drifted inputs;
- PowerShell AST rejection of shipped providers that contain file/config mutation, direct process/service/task starts, package installation, or dynamic invocation;
- diagnostic-probe rejection of shells, metacharacter interpretation, configurable working directories, inherited stdin, runtime-config-derived arguments, unapproved profiles, and executable or argument drift;
- diagnostic-probe process-tree timeout, bounded normalized output, and version/configuration facts delivered to providers without direct child-process creation;
- adding a fixture provider, existing-profile probes, and new bounded reason/guidance catalog entries through the registry without changing engine code;
- native async-hook startup latency in real supported Claude Code, Codex CLI, and desktop clients, with no detached child retaining hook pipes;
- runner exit `0` for provider errors, timeouts, malformed JSON, registry errors, cache errors, and start failures;
- SID-scoped mutex ACL, zero-wait acquisition, abandoned ownership, and cooldown behavior across concurrent local and remote desktop invocations;
- lock losers exiting silently without reading cache, changing cooldown or notification state, or emitting hook output;
- cache reads and start-ledger reads occurring only after lock acquisition;
- corrupt, missing, and future-dated cache or start-attempt data behaving conservatively;
- missing or corrupt start ledgers suppressing auto-start for the current run, quarantining corrupt data, atomically recreating an empty ledger, and permitting normal eligibility on the next run;
- one all-client provider-by-surface result matrix preventing cross-client freshness suppression;
- dependency ordering, global-to-surface and same-surface dependency mapping, rejection of global-to-surface dependencies, and a four-provider concurrency limit;
- disabled, filtered, skipped, timed-out, malformed, and failed dependencies suppressing auto-start;
- provider Job Object cleanup terminating a forked child tree on timeout or runner exit;
- concurrent bounded stdout/stderr draining, UTF-8 handling, and flood-output truncation;
- atomic cache writes and recovery from a corrupt previous cache;
- identical-warning suppression and immediate reporting for changed warning sets;
- rejection of provider free-form messages, unknown reason/guidance codes, mismatched IDs, oversized facts, and excess keys;
- strict enforcement that provider results, registry fields, hook input, and context files cannot add to or alter the compiled auto-start policy;
- exact `\\LarkClaudeGateway` task-definition fingerprint validation for action count, executable, arguments, working directory, principal SID, logon type, run level, enabled state, execution limit, restart settings, and the complete expected trigger/action sets;
- successful fixed gateway scheduled-task start through the engine-owned helper, termination of a hung helper after three seconds, and a separate bounded ten-second readiness phase polling every 250 milliseconds;
- exact `Ready`, `Running`, `Queued`, `Disabled`, missing, and unknown task-state behavior;
- running-state task result codes not being misreported as completed failures;
- PID reuse, executable mismatch, process-start mismatch, stale/future health, clock skew, and ACL/read errors remaining warning-only;
- notification bootstrap failure never triggering the bootstrap task;
- token-meter drift never invoking its installer or repair script;
- Chrome DevTools MCP checks for pinned version, local paths, `--autoConnect`, optional status, and missing client configuration;
- Chrome, remote-debugging, MCP, proxy, dependency, and configuration failures remaining warning-only;
- JSON duplicate-key rejection and targeted edits preserving comments, encoding, newlines, ACLs, and unrelated hooks;
- optimistic hash conflicts aborting installation without overwriting concurrent changes;
- second-file replacement failure restoring the first file only while file identity and installed hash still match the just-installed candidate;
- concurrent edits after the first replacement being preserved, with an explicit manual-recovery diagnostic instead of rollback overwrite;
- exact owned-hook update/uninstall identity and refusal to remove similar or modified user hooks;
- `startup|resume` matching while `clear|compact|fork` do not trigger the runner;
- minimum-version and async-capability gates refusing unsupported clients without changing configuration;
- installation initializing `mode.json` to `warn-only`, explicit atomic transition through `Enable-StartupHealthAutoStart.ps1`, and `warn-only`, missing, unreadable, malformed, unknown-version, or unknown-value mode never creating the start helper;
- absent Claude or Codex configuration targets using guarded no-replace atomic creation with inherited parent ACLs, losing a create race without overwrite, and rollback deleting an installer-created file only while its identity and installed hash still match;
- rollback being able to return auto-start to `warn-only` while leaving checks installed and operational;
- no hook or provider result can emit a blocking decision or nonzero client-facing exit status;
- bounded logs and results never contain fixture secrets, prompts, transcript text, Feishu identifiers, or browser URLs.

Manual acceptance verifies that Claude Code, Codex CLI, and the Codex desktop app become usable immediately while a deliberately stopped installed gateway starts in the background, and that a non-repairable failure produces one concise advisory without preventing normal work.

## Rollout And Rollback

Rollout first installs and validates the health scripts and pinned parser dependency, writes the approved registry, provider, diagnostic-probe, and task-definition identities and hashes to `install-manifest.json`, and atomically initializes `mode.json` to `warn-only`. It next validates supported client versions and async-hook behavior before transactionally installing the two user-level hooks. Canary acceptance covers startup latency, immediate client termination, resume, client upgrade, malformed hooks, provider child-process cleanup, output delivery, and a full all-surface snapshot. Existing feature installers and scheduled tasks remain unchanged.

After the warning-only canary passes, the operator explicitly runs `Enable-StartupHealthAutoStart.ps1`. The script revalidates the installed manifest and exact `\\LarkClaudeGateway` policy preconditions, then atomically changes only `mode.json` to `enabled`. Missing or invalid mode data always behaves as `warn-only`; the runner never infers enablement from registry or provider data.

An empty `%LOCALAPPDATA%\ai-startup-health\disabled` file is the immediate kill switch and makes every installed hook return silently with exit `0`. Full rollback runs the transactional health-hook uninstaller and removes only the exact owned Claude and Codex `SessionStart` entries. Partial uninstall restores its first edit if the second fails and retains backups on any rollback failure. Rollback does not stop any service, remove checked features, restore unrelated configuration, or delete health history.

Auto-start-only rollback atomically changes `mode.json` back to `warn-only` and leaves startup checks and advisory reporting active. Full rollback and partial uninstall use the same file-identity and installed-hash guards as installation: they restore a file only if it still matches the owned candidate, preserve any concurrent user or client edit, and report manual recovery when guarded restoration is no longer safe.

