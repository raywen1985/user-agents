# AI Client Startup Health

## Goal

Add one extensible, non-blocking startup health system shared by Claude Code, Codex CLI, and the Codex desktop app. It checks the local features required for the user's AI workflow, starts an already-installed service when that operation is explicitly allowed, and reports concise guidance for conditions that cannot be repaired safely.

Health work must never synchronously wait on, fail, cancel, or change the exit status of a client startup. The hook entry performs only a 500-millisecond fail-closed compatibility guard before any long-running work; an unsupported or unidentifiable upgraded client exits `0` from that guard without starting the runner. A failed check, malformed result, timeout, or failed service start is diagnostic information only.

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

The startup-time health runner does not:

- install software, feature packages, scheduled tasks, feature hooks, or MCP servers; the separately invoked `Install-StartupHealth.ps1` may install only this framework's own hook entries and pinned parser dependency;
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

1. **Client hooks** invoke a minimal compatibility guard for Claude and Codex session starts. Hooks match `startup|resume` so a fresh CLI session and a desktop-restored session both participate. They do not match `clear`, `compact`, or `fork`.
2. **The health runner** continues in the same client-owned asynchronous hook process only after the guard approves the invoking runtime. It applies a cross-session user lock, per-policy cooldowns, provider concurrency limits, timeouts, result normalization, the closed service-start policy, atomic caching, and warning aggregation.
3. **Check providers** are independent scripts registered in a versioned manifest and required by contract to perform read-only checks. Providers report facts and start eligibility but never receive framework authority to start a process, task, or service.

Codex hooks and Claude hooks both use their native `async = true` command-hook setting. The runner does not detach another process, so its bounded stdout remains attached to the hook host and can be delivered through the client's documented asynchronous hook-output path. On an approved runtime, the client continues startup without waiting for the runner. Stdin, stdout, and stderr are never inherited by provider descendants.

Version 1 is installed only when every discovered local runtime that can consume the edited user hook file matches the versioned compatibility matrix. The initial matrix contains the exact tested versions Claude Code `2.1.252`, standalone Codex CLI `0.153.4`, Codex desktop's embedded `codex.exe` `0.163.0-alpha.10.2`, and Codex desktop internal application build `26.1013.40934`; it does not imply an open-ended `or later` range. The installer also validates candidate hook configuration through each available client's configuration-validation path. If any consumer is not represented by an exact entry or explicitly tested closed interval, or lacks a working validator, the transactional installation aborts before either user hook file changes and reports the incompatible consumer. The installer never falls back to a synchronous hook.

The compatibility matrix is a versioned test artifact, not an indefinitely assumed range. Every supported Claude, Codex CLI, or desktop upgrade is rerun through the native async-hook integration suite before its exact version is added, or before evidence-backed lower and upper bounds are changed for a closed interval. Unknown, older, newer, or explicitly excluded versions that do not match the matrix remain untouched by the installer.

Codex command hooks are used instead of MCP tool hooks because Codex can run `SessionStart` before MCP connections are ready. Chrome DevTools MCP readiness is therefore inferred from local configuration and client-visible state, not by requiring an MCP tool call during the hook.

The Codex hook assumptions in this design follow the official [Hooks documentation](https://learn.chatgpt.com/docs/hooks): background command hooks use `async: true`, retain the configured timeout, deliver informational output later, and receive a `SessionStart` schema that does not identify CLI versus desktop.

## Runtime Identity And Surface

Installation enumerates every known consumer of the user hook files, including the canonical Claude executable, every standalone Codex launcher found from the user and machine `PATH` definitions and their referenced package-manager bin directories, and each installed Codex desktop embedded runtime. It records canonical executable paths, file identities, sizes, last-write metadata, signed/file version metadata, resolved CLI versions, and desktop installation metadata in `install-manifest.json`.

| Surface | Compatibility version source | Runtime surface evidence |
| --- | --- | --- |
| `claude` | Exact output from the canonical `claude.exe --version` approved at installation | Separately owned Claude hook plus approved ancestor executable identity |
| `codex` | Exact `--version` output from each canonical standalone Codex launcher/engine discovered outside the desktop installation | Approved standalone ancestor executable identity without the desktop-origin combination |
| `desktop` | Internal application build read from the installed signed app's `resources/app.asar` package metadata, plus exact `--version` output from that installation's embedded `codex.exe` | Approved `app.asar` identity/build, embedded-runtime ancestor identity, and `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=Codex Desktop` |

The MSIX or other package-manager version is recorded only as a diagnostic fact because it does not identify the app's hook implementation. The shared `~/.codex/hooks.json` is installed only when all discovered Codex consumers match the matrix.

At every hook invocation, `Invoke-StartupHealthHook.ps1` checks the `disabled` kill-switch marker first and exits silently when it exists. Otherwise it runs a 500-millisecond guard that launches no child process, performs no network access, and acquires no health mutex. The guard opens only the manifest-recorded invoking hook file under a fixed size cap and requires exactly one byte-exact owned-handler projection recorded by the installer. That projection includes the event, matcher, canonical command path, owner argument, native `async: true` setting, and 75-second timeout; unrelated bytes elsewhere in the configuration do not participate. Reformatting or changing any owned field fails closed until an explicit reinstall records the new projection. The guard then identifies the nearest supported ancestor runtime through bounded Windows process APIs and compares its canonical path, file identity, size, last-write value, and local signed/file version metadata with the installed manifest. Claude is also identified by its separately owned hook command. Codex is classified as `desktop` only when the ancestor is the approved desktop-embedded runtime, the associated `app.asar` path/identity/size/last-write facts still match, a bounded no-child-process ASAR metadata read still yields the approved internal build, and inherited `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` equals the tested `Codex Desktop` value; the environment value is a hint and cannot override executable or application identity. An approved standalone ancestor is `codex`. A missing, duplicate, or drifted owned-handler projection, or a missing, ambiguous, drifted, or unapproved runtime identity, fails closed: the guard emits at most one built-in compatibility warning, exits `0`, and never loads the registry, providers, cache, or auto-start engine.

Hook JSON input supplies only bounded session metadata and the `startup|resume` source. It is not trusted to distinguish Codex CLI from desktop because the documented `SessionStart` schema has no application-identity field. Surface classification and runtime compatibility therefore come from the owned hook, approved ancestor identity, and the guarded desktop-origin hint. The installer and canary suite verify this ancestry and environment behavior for every matrix entry. A post-install client update changes a recorded identity or version, causing the entry guard to self-disable before any 60-second runner work even if that client no longer honors `async` correctly.

## Files And Ownership

The implementation lives under a new `startup-health/` directory:

```text
startup-health/
  README.md
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
activation.json
mode.json
install-manifest.json
disabled
runner.log
```

Writes use a temporary sibling file followed by an atomic replace. `runner.log` is capped at 2 MiB and keeps at most three rotated 2 MiB files; rotation uses guarded same-directory replacement and logging failure never changes runner behavior. Logs contain no prompts, transcript content, commands, environment dumps, tokens, credentials, Feishu message content, or browser page data.

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
  "freshnessSeconds": 60,
  "cooldownSeconds": 300,
  "dependsOn": ["runtime-dependencies"],
  "reasons": {
    "listener-ready": "Feishu remote gateway is ready.",
    "live-gateway-external-to-task": "A validated gateway is running outside the scheduled task.",
    "policy-task-definition-drift": "Gateway task definition no longer matches the approved auto-start policy."
  },
  "guidance": {
    "reinstall-health-policy": {
      "text": "Re-run the startup-health installer after reviewing the gateway task change.",
      "documentation": "startup-health/README.md#task-definition-drift"
    }
  }
}
```

The engine validates before execution:

- the schema version is supported;
- IDs are unique and use a restricted identifier grammar;
- script paths are relative, canonicalize below `startup-health/checks/`, and resolve to regular files;
- dependency IDs exist and contain no cycles;
- `scope` is `global` or `surface`, and surface-scoped checks declare at least one supported client;
- provider timeouts are 500-15000 milliseconds, diagnostic-probe timeouts are 500-10000 milliseconds, freshness is 5-1800 seconds, and cooldowns are 0-86400 seconds;
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
  "dependencyReady": true,
  "facts": {
    "listenerReady": true
  }
}
```

Allowed statuses are `ok`, `warn`, and `error`. Allowed `startEligibility` values are `not-needed`, `eligible`, and `unsupported`. `reasonCode` and `guidanceId` use restricted identifiers and must exist in that check's installed, validated registry catalog or the engine's built-in protocol-failure catalog. The returned `id` and `surface` must exactly equal the invocation. `facts` is limited to 16 keys, scalar values, 256 bytes per string, and 4 KiB total. Provider free-form text is rejected and never flows directly to logs or client output.

A global provider runs once with `surface: global`. A surface-scoped provider runs once for each declared surface and produces a separate normalized result for `claude`, `codex`, and/or `desktop`. The snapshot stores results as a provider-by-surface matrix. Dependencies resolve to the same surface when both providers are surface-scoped; a surface-scoped provider may depend on a global result, while a global provider cannot depend on a surface-scoped result. Auto-start policy is permitted only on global providers, and one policy ID can produce at most one start attempt per completed snapshot.

Provider execution outcome is tracked separately as `completed`, `timed-out`, `protocol-error`, `process-error`, `disabled`, `client-filtered`, or `dependency-skipped`. A health status is accepted only from a provider result whose originating execution completed successfully. Every result also declares `dependencyReady`; automatic start requires each dependency either to have completed successfully in the current run or to come from a still-fresh cached result whose original outcome was `completed`, and to have `dependencyReady: true`. Disabled, filtered, skipped, timed-out, malformed, or stale dependencies always suppress automatic start.

The engine owns all automatic-start authority. In version 1 its compiled policy table contains exactly one entry:

```text
lark-gateway-task-v1 -> Start-ScheduledTask -TaskPath \ -TaskName LarkClaudeGateway
```

The exact task path, task name, and operation are constants in the engine and cannot be supplied or changed by the registry, provider output, hook input, or context file. During every gateway-provider evaluation, and again immediately before a possible invocation, the engine compares the live task definition with the complete expected definition captured in the explicit installation manifest: exactly one action; canonical Node executable; exact quoted `src\gateway.mjs` argument; the canonical gateway project directory approved at installation; current user SID; interactive logon; limited run level; enabled state; zero execution limit; exact restart count/interval; and the exact expected trigger and action sets with no additional entries. Any ambiguity, task-path mismatch, principal mismatch, or definition drift suppresses start and produces the bounded `policy-task-definition-drift` warning with `reinstall-health-policy` guidance, even when the currently running gateway itself is healthy. The engine never silently downgrades this condition to a healthy auto-start policy. Adding a future read-only check requires only a registry entry and provider. Adding or changing automatic-start authority requires an explicit engine policy change and dedicated security tests.

The engine considers its fixed start action only when all of these conditions hold:

- `mode.json` was successfully parsed at its supported schema version and `autoStart` is exactly `enabled`;
- every required installed surface has non-pending activation evidence whose owned-handler projection hash and runtime-manifest hash exactly match the current installed generation and whose warning-only canary outcome passed;
- the provider returned `startEligibility: eligible` with the expected reason code;
- the registry selects the matching compiled policy ID;
- every dependency either completed successfully in this run or is an originally-completed still-fresh cached result, and returned `dependencyReady: true`;
- the per-check cooldown allows an attempt;
- the engine owns the cross-session lock;
- the engine has re-queried the exact scheduled task and the policy's preconditions still hold.

The start phase has one absolute three-second deadline covering control-state revalidation, attempt-ledger persistence, helper creation, task invocation, output draining, and Job Object cleanup. Immediately before recording or invoking a start, while still holding the coordination mutex, the engine reopens and revalidates `mode.json`, `activation.json`, the owned-handler projection, the installed runtime-manifest generation, and the live task definition. Any missing, corrupt, pending, changed, non-passing, or over-deadline control state suppresses the helper. Only after that revalidation does the engine atomically persist the attempt timestamp, policy ID, and manifest generation to `start-attempts.json`. It then launches an engine-owned helper whose code contains the same fixed task path and name, inside a kill-on-close Job Object whose invocation timeout is the remaining start-phase time, never a fresh three seconds. The helper accepts no task parameters. If any pre-helper step exhausts the deadline, no helper is created; if the helper exhausts it, the Job Object is closed before the readiness phase. Only a successful invocation before that absolute deadline begins a separate, engine-owned readiness monitor with its full 30-second reservation; this monitor is started once and performs its polling internally rather than launching a provider or PowerShell process on every tick. A start action can only start the existing, enabled, definition-matched task named by compiled policy.

Malformed output, nonzero exit, timeout, or unexpected provider termination becomes an isolated warning. The runner continues with independent providers.

## Scheduling And Non-Blocking Guarantees

Every `startup|resume` hook may launch a runner, but only one runner for the Windows user can perform work across local and remote desktop sessions. The runner uses `Global\AIStartupHealth-<SHA256(user-SID)>`, with an ACL granting only `SYNCHRONIZE | MUTEX_MODIFY_STATE` to the current SID and `SYSTEM`, the minimum rights required to open, wait on, acquire, release, and close the named mutex. This is also the control mutex for installer updates, auto-start enablement, uninstall, and rollback. A runner attempts acquisition with zero wait and, if the lock is owned, exits `0` silently without reading cache or updating notification state. Explicit control commands may wait for the current owner under a bounded operator-facing timeout, then hold the same mutex for their complete validation-and-write transaction; timeout aborts the command before any state change and reports retry guidance. No supported component writes hook, manifest, mode, or activation control state outside this mutex.

The owner intentionally holds the same lock through readiness and the atomic result commit. Releasing it after the start attempt would allow a second runner to race snapshot, cooldown, and readiness writes or to act on an incomplete start. The accepted tradeoff is that another client opened during the at-most-30-second readiness phase receives no result from that invocation; its startup remains immediate, and the next `startup|resume` trigger can use the committed snapshot. Version 1 does not add a second readiness lock or permit lock losers to publish speculative state.

After acquiring the lock, the runner re-reads mode, activation, installed-manifest generation, cache, and cooldown files before making any decision. An abandoned mutex is accepted as ownership, recorded as a bounded diagnostic fact, and followed by normal state revalidation. Missing, corrupt, future-dated, or clock-skewed freshness data is treated as stale. Missing, corrupt, pending, stale, or non-passing activation evidence suppresses automatic start even when mode says `enabled`; it is reported as a bounded control-state warning and is never promoted to passing outside a real warning-only canary invocation. On first installation, the installer creates valid empty start-attempt and notification ledgers. If `start-attempts.json` is later missing or corrupt, the runner suppresses automatic start for the current run, quarantines a corrupt file with a timestamped name, and atomically creates a valid empty ledger under the lock; the next run may auto-start after normal checks. If `last-notified.json` is missing or corrupt, the runner similarly quarantines corrupt data and atomically creates an empty notification ledger, then treats the current warning set as not previously delivered. Notification-ledger recovery never suppresses checks or grants auto-start authority.

Cache freshness is tracked per provider-and-surface cell. The default is five minutes; the gateway provider uses 60 seconds because its local task, PID, and health-file check is cheap and service liveness can change between wider snapshots. When any surface-scoped provider expires, the runner refreshes that provider for every declared client surface regardless of which client invoked the runner; a global provider runs once. It also refreshes any stale dependency closure and atomically merges still-fresh cells into a new snapshot generation. Presentation selects global results plus the requesting surface's results, so a Claude-triggered refresh cannot suppress a needed Codex or desktop check. An auto-start policy is considered only when its owning global provider completed in the current run and all dependency results are completed or still fresh and ready. Provider freshness, service-start cooldown, and notification deduplication are stored and evaluated independently.

The runner reserves the first second of the check phase for locked state/cache loading and planning. It then runs diagnostic probes in a separate subphase, deduplicated by profile, executable identity, exact arguments, and surface. One result is reused by every dependent check and surface in that run. Up to eight independent probes run concurrently under a seven-second aggregate probe budget; queued or unfinished probes at the boundary are cancelled and normalized once for all consumers. The registry validator simulates the deterministic probe schedule from declared maxima and rejects an initial registry whose critical path cannot fit this sub-budget. Probe time is never charged to `checkTimeoutMs`.

After probes settle, the runner reserves ten seconds for up to four concurrent providers after their dependencies complete, followed by two seconds for cancellation, normalization, and the atomic snapshot merge. The registry validator likewise rejects a provider dependency graph whose deterministic worst-case waves and critical path cannot fit ten seconds. Initial provider timeouts are 2000 milliseconds for model proxy, 3000 for gateway, notifications, and Chrome DevTools MCP, and 5000 for token meter, runtime dependencies, and configuration integrity. Initial diagnostic-probe timeouts are 3500 milliseconds for version and pinned-JSON validation and 6500 for Codex configuration validation, leaving explicit broker cleanup margin inside the seven-second subphase.

The runner has a 60-second hard lifetime with explicit phase reservations: at most 20 seconds for cache loading, diagnostic probes, and providers; three seconds for the complete start phase described above; 30 seconds for gateway readiness; five seconds for persistence, rendering, and cleanup; and two seconds of shutdown margin. If the check phase exhausts its budget, unfinished work is cancelled and normalized as warnings, and automatic start is skipped so the readiness reservation is never consumed by checks. A runner that does not need auto-start exits as soon as reporting completes. The runner closes all remaining probe, provider, start, and readiness Job Objects when any phase or overall limit is exceeded. These limits protect background resources; they are not client-startup deadlines because clients do not wait for an asynchronous hook. Both clients configure the native asynchronous hook timeout to 75 seconds, which exceeds the runner's hard lifetime and cleanup margin.

All guard and runner top-level paths use `try/finally` and force process exit code `0`. Provider status never propagates to the client process. The hooks return no `continue: false`, blocking decision, permission decision, or rewritten input. The entry-point `disabled` check is the highest-priority local kill switch: when present, the hook exits `0` silently before runtime warnings, registry loading, providers, cache access, or service starts.

`mode.json` controls automatic start independently from health checking. Its version-1 schema is `{ "schemaVersion": 1, "autoStart": "warn-only" | "enabled" }`. A fresh installation initializes it to `warn-only`. Every framework update, while holding the shared control mutex, atomically sets it to `warn-only` before changing a hook, runtime manifest, or activation evidence, even when the previous mode was valid and enabled; an update never restores `enabled` automatically. A missing, unreadable, malformed, unsupported, or unknown mode also fails closed to `warn-only`, emits only a bounded diagnostic after checks run, and never prevents health reporting. `Enable-StartupHealthAutoStart.ps1` is the sole supported transition to `enabled`; while holding the same mutex, it validates the installed manifest, complete current activation evidence, owned-hook projection, and fixed gateway policy, then atomically replaces the mode file. The kill switch takes precedence over both modes.

## Reporting

Healthy startup is silent. Warnings are summarized into one bounded payload string, for example:

```text
AI health: token-meter=warn(claude-hook-missing) | lark-notify=warn(bootstrap-last-run-failed) | chrome-devtools-mcp=warn(codex-not-configured)
```

The runner never writes a plain-text warning to hook stdout. For Codex `SessionStart`, it writes one JSON line with the payload in the documented top-level `systemMessage` field; background delivery surfaces that value as a warning rather than adding it as developer context. For Claude, the client adapter writes the same payload through the tested top-level `systemMessage` JSON field for the supported Claude hook version. Both envelopes omit `continue`, decisions, context, and all other control fields.

The payload contains at most eight warning segments and 1024 UTF-8 bytes. Warnings are ordered by severity, then stable registry order; whole lowest-priority segments are omitted until the byte cap fits, and a catalog-owned `more-warnings` segment reports only the bounded omitted count. After JSON escaping, the complete single-line envelope including its trailing newline is capped at 1280 UTF-8 bytes; the renderer drops additional whole segments if needed to meet that second cap. Provider text is never partially truncated or interpolated. The compatibility guard uses the same client-specific envelope for its one built-in warning. Codex may surface asynchronous hook output at its next safe conversation point. The cache remains the source of truth when a client does not display background output.

Repeated identical warning sets are suppressed for 30 minutes per client. This interval is intentionally longer than provider freshness: frequent startup or resume events may revalidate health without repeatedly showing an unchanged advisory. A changed warning set is eligible for immediate display. `latest.json` records the complete normalized results, timestamps, durations, and auto-start outcomes so a future manual status command can show detail without repeating startup work.

Messages are rendered only from either the engine's small built-in failure catalog or the installed registry's validated, digest-pinned per-check `reasonCode` and `guidanceId` catalog. They state the condition and an allowlisted manual recovery command or repository-relative documentation path when one is known. Provider strings, paths, and facts are not interpolated into client output. Messages do not claim that a feature was repaired unless the bounded recheck confirms it.

## Initial Providers

### Token Meter

The provider checks that:

- the token-meter scripts and module exist;
- Claude has the owned `Stop` hook and status-line command;
- Codex has the owned `Stop` hook and expected status-line configuration;
- the machine/user data directory exists and the current Windows token passes an ACL `AccessCheck` for the required create/write/delete rights;
- invocation markers and the install manifest are parseable.

The ACL result is an advisory permission check and does not create a probe file. Missing hooks, status-line configuration, denied rights, or stale markers produce warnings. The provider never runs the installer, writes a test file, or rewrites token history. It cannot auto-start.

### Feishu Notifications

The provider checks the notification script, bridge script, notification JSON, `lark-cli` executable, Claude notification hooks, Codex notification hook, Codex native notification bridge, and `LarkNotifyBootstrap` scheduled-task metadata.

The bootstrap task's missing or disabled state is reported. `LastTaskResult` is interpreted only after a completed run; while the task is `Running` or `Queued`, running-state codes such as `0x41301` are not treated as failures. Other nonzero completed results are rendered as bounded hexadecimal diagnostic codes. The provider does not trigger the task because the bootstrap can modify client configuration. It has no auto-start policy.

### Feishu Remote Gateway

The provider checks that the existing `LarkClaudeGateway` scheduled task is installed and enabled, then evaluates its task state and `run/health.json`. As a rollout prerequisite, the gateway captures an immutable `processStartedAt` at process entry, before listener startup or inbox replay, and includes it in every health document; the existing `startedAt` continues to mean application readiness after those operations. `processStartedAt` is derived from the process clock rather than from readiness time. A healthy result requires `updatedAt` no more than 45 seconds old with 15 seconds of future-clock tolerance, `listenerReady: true`, and `stopping: false`. The recorded PID must identify a live process whose canonical executable equals the configured Node executable and whose OS process start time matches `processStartedAt` within five seconds. A missing `processStartedAt` is incompatible health data, not a reason to widen the identity tolerance.

Because the current gateway writes `health.json` in place, the provider caps the file read at 64 KiB and, on an empty, truncated, sharing-violation, or JSON-parse failure, waits 100 milliseconds and retries exactly once from a newly opened handle. A second failure, oversized file, access denial, malformed schema, or ACL error becomes a warning and is never start-eligible. This compatibility retry does not treat persistently invalid health as healthy.

Task state is mapped exactly:

- `Running` or `Queued`: never start; report healthy only when validated health is fresh, otherwise warn;
- `Ready` with a validated live healthy gateway: return `ok`, `reasonCode: live-gateway-external-to-task`, and `startEligibility: not-needed`; this covers a manually started gateway without claiming the scheduled task launched it;
- `Ready` without a validated live healthy gateway: return `eligible`;
- `Disabled`: warn and do not start;
- missing, unknown, or transient states: warn and do not start.

Immediately before auto-start, the engine re-queries the task and proceeds only if it is still exactly `Ready`, enabled, and has no validated live gateway. The fixed engine policy uses its bounded helper to call `Start-ScheduledTask -TaskPath \ -TaskName LarkClaudeGateway`, then starts the single 30-second readiness monitor. That monitor performs bounded health-file reads in its own loop every 250 milliseconds and samples task state internally without launching a new provider or shell per poll. The task must enter `Running` or `Queued` within three seconds and must not return to `Ready`, become disabled, disappear, or enter an unknown terminal state before readiness. Success requires a newly written, validated health document whose PID, executable, `processStartedAt`, `listenerReady`, `stopping`, and freshness fields all pass the same rules above and whose `updatedAt` is not older than the recorded start attempt. Failure to reach validated health while the task remains active is a startup-timeout warning; early task exit is a distinct warning. Neither provider nor engine registers the task, kills a process, or invokes the restart workflow.

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
2. enumerates all discovered Claude, standalone Codex, desktop-embedded Codex, and applicable IDE consumers of the user hook files and records their exact version sources and executable identities;
3. requires every discovered consumer to match the compatibility matrix and passes the runtime-ancestry, surface-classification, and native async-hook canary for that exact entry;
4. verifies that the approved gateway deployment supports the immutable `processStartedAt` health field before auto-start can later be enabled;
5. loads the current Claude `settings.json` and Codex `hooks.json` without discarding unrelated user entries;
6. records source hashes and, for each existing target, its file identity, ACL, encoding, and timestamped backup; a missing target is recorded as an explicit absent-file identity together with its parent-directory identity and inherited ACL;
7. stages both candidate files and adds one owned `SessionStart` matcher for `startup|resume` to each client;
8. sets the command hook to native asynchronous execution with a 75-second host timeout, exceeding the runner's 60-second hard lifetime and cleanup margin;
9. validates both candidates with the JSON parser and available client configuration validators;
10. acquires the shared health/control mutex under a bounded installer timeout, atomically sets an existing installation to `warn-only`, reopens each existing target with a Windows handle that denies concurrent write sharing, and rechecks its file identity and original hash immediately before replacement; for an absent target, it rechecks that the same parent directory exists and the target is still absent;
11. atomically replaces existing files with `ReplaceFileW`, preserving their original ACLs; for an absent target, it stages a same-directory candidate with the parent's inherited ACL and uses a no-replace atomic `MoveFileExW`, treating an already-created destination as a conflict; it records each exact installed identity and hash;
12. if the second operation fails, restores a replaced first file only when its current identity and hash still equal the just-installed candidate; if the installer created the first file, it removes that file only under the same identity-and-hash guard; if another process changed or replaced it, the installer preserves that change and reports manual recovery instead of overwriting or deleting it;
13. while still holding the mutex, records the exact installed hook-definition and runtime-manifest hashes in `activation.json` and marks every required surface pending;
14. verifies both final hook-file hashes plus the pending activation state before releasing the mutex, retaining all backups on mismatch or rollback failure, then instructs the operator to review and trust the new Codex hook through `/hooks`; it never bypasses trust or claims the hook is active merely because configuration was written.

Codex skips a new or changed non-managed hook until the user trusts its exact definition hash. After trust, the operator starts or resumes each installed surface once. A hook invocation that passes the runtime guard, observes `mode.json` as `warn-only`, and acquires the health lock atomically records that surface's exact runtime identity, owned-handler projection hash, complete runtime-manifest hash, timestamp, and warning-only canary outcome in `activation.json`. Actual execution is the proof of trust; the installer does not infer trust from private client state. Claude records the equivalent canary evidence even though its activation flow differs. A changed owned hook definition, changed approved runtime identity, corrupt/missing activation file, or reinstall resets the affected entries to pending.

`Enable-StartupHealthAutoStart.ps1` acquires the shared health/control mutex and refuses to enable auto-start until every required installed surface has current activation evidence for the exact hook and runtime manifest and the warning-only canary passed. It reports the remaining `/hooks` review or surface-launch steps. This activation gate applies to first installation and updates.

The owned-hook identity is the `SessionStart` event, normalized absolute command path to `Invoke-StartupHealthHook.ps1`, exact owner argument `-Owner AIStartupHealthV1`, matcher `^(startup|resume)$`, native asynchronous value `true`, and timeout `75`. Update and uninstall operations touch only a handler with that complete identity and the recorded installed projection hash. A similar command, different owner argument, user-modified matcher, synchronous value, timeout, or projection is reported for manual review rather than removed.

After all update preflight and compatibility checks pass, re-running the installer acquires the shared health/control mutex, atomically sets `mode.json` to `warn-only`, then updates only the owned hook definition and the framework's approved manifest and invalidates affected activation evidence before releasing the mutex. It never restores the previous auto-start mode and never installs or repairs any checked feature. An uninstaller and auto-start-only rollback use the same mutex; they first atomically set `mode.json` to `warn-only`, then perform their remaining owned-state operations before release. Full uninstall removes only the exact owned hooks. It retains `install-manifest.json`, `activation.json`, `start-attempts.json`, `last-notified.json`, `disabled`, logs, and health snapshots for audit and conservative reinstall behavior; it marks the manifest and activation state uninstalled with a timestamp only after both hook removals succeed. Retained state is reported explicitly and is never interpreted as an installed hook. No automatic purge is performed.

Codex CLI, the Codex desktop app, and an applicable IDE extension can share the same user MCP and hook configuration on the same Codex host. The installer treats every discovered consumer as part of the compatibility decision, while the runtime guard protects against a later undiscovered or upgraded consumer. No MCP server is marked `required`, so an optional integration failure cannot fail Codex startup.

## Security Boundaries

- The registry and provider directory are trusted executable configuration with the same authority as the Windows user; they are not a sandbox boundary. Installation records their approved digests and runtime refuses drift.
- Provider paths cannot escape the owned checks directory through relative paths, links, or alternate data streams.
- Shipped providers obey a tested read-only contract. Within the health framework, provider output and registry data cannot expand the engine's compiled start-policy table; version 1 contains only the exact definition-matched `\LarkClaudeGateway` scheduled task. Malicious same-user modification of trusted executable files is outside this guarantee.
- No provider accepts a command path, task name, script path, or start instruction from hook input, registry fields, or context files.
- Hook input is used only for bounded session metadata and the start source after strict parsing; client and surface identity come from the owned hook plus the guarded runtime ancestry described above.
- Health output excludes secrets, environment values, prompts, transcripts, Feishu identifiers, browser URLs, and file contents.
- A check cannot grant permissions, answer an approval request, or change a client's sandbox mode.

## Testing

Automated tests must cover:

- manifest schema validation, duplicate IDs, invalid paths, links, cycles, unknown dependencies, unknown auto-start policy IDs, provider timeouts outside 500-15000 milliseconds, probe timeouts outside 500-10000 milliseconds, freshness outside 5-1800 seconds, cooldowns outside 0-86400 seconds, and other bounded numeric fields;
- `install-manifest.json` verification of the registry digest, provider canonical paths and SHA-256 digests, and diagnostic-probe executable identity, digest, and exact argument vectors, including refusal of missing, linked, alternate-stream, path-drifted, and digest-drifted inputs;
- PowerShell AST rejection of shipped providers that contain file/config mutation, direct process/service/task starts, package installation, or dynamic invocation;
- diagnostic-probe rejection of shells, metacharacter interpretation, configurable working directories, inherited stdin, runtime-config-derived arguments, unapproved profiles, and executable or argument drift;
- diagnostic-probe process-tree timeout, bounded normalized output, and version/configuration facts delivered to providers without direct child-process creation;
- adding a fixture provider, existing-profile probes, and new bounded reason/guidance catalog entries through the registry without changing engine code;
- native async-hook startup latency in real supported Claude Code, Codex CLI, and desktop clients, with a 75-second host timeout and no detached child retaining hook pipes;
- Codex keeping a newly installed or changed hook pending until the operator reviews and trusts its exact definition through `/hooks`, followed by an actual warning-only invocation before that surface becomes active;
- `activation.json` requiring exact hook-definition and runtime-manifest hashes per installed surface, treating missing or corrupt evidence as pending, and invalidating only affected evidence after a hook or runtime change;
- `Enable-StartupHealthAutoStart.ps1` refusing incomplete, stale, corrupt, or non-passing activation evidence and reporting the remaining trust or surface-launch step;
- discovery of every local consumer of shared Claude/Codex hook files, with standalone CLI version, desktop internal build, embedded `codex.exe` version, and diagnostic-only package-manager version taken from their specified sources;
- client-version matrix maintenance that rejects an untested upgrade until the async-hook integration suite approves and records it;
- the entry guard completing within 500 milliseconds without child processes, network, cache, or mutex access; requiring exactly one byte-exact installed owned-handler projection; approving every matrix runtime; and exiting `0` before runner work for upgraded, drifted, missing, ambiguous, or unapproved ancestors even when a fixture host ignores `async`, including an `app.asar`-only desktop update and changes only to the hook's `async` or timeout fields;
- Codex CLI versus desktop classification using approved ancestor identity plus `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`, including proof that a spoofed environment value cannot turn an unapproved executable into `desktop`;
- the `disabled` marker taking priority over runtime compatibility warnings, registry loading, cache access, providers, and auto-start;
- runner exit `0` for provider errors, timeouts, malformed JSON, registry errors, cache errors, and start failures;
- SID-scoped mutex ACL granting only `SYNCHRONIZE | MUTEX_MODIFY_STATE`, zero-wait acquisition, a second process opening, acquiring, releasing, and closing an existing mutex, abandoned ownership, and cooldown behavior across concurrent local and remote desktop invocations;
- lock losers exiting silently without reading cache, changing cooldown or notification state, or emitting hook output;
- the runner reading mode, activation, manifest generation, cache, and start-ledger decision state only after lock acquisition, independently of the entry guard's earlier read-only compatibility check, with exact mode/activation/generation revalidation immediately before recording or invoking a start;
- corrupt, missing, and future-dated cache or start-attempt data behaving conservatively;
- missing or corrupt start ledgers suppressing auto-start for the current run, quarantining corrupt data, atomically recreating an empty ledger, and permitting normal eligibility on the next run;
- missing or corrupt notification ledgers being quarantined and recreated while treating the current warning set as not previously delivered;
- per-cell freshness, a 60-second gateway TTL, a five-minute default TTL, stale dependency-closure refresh, atomic merging of still-fresh cells, and all declared surfaces preventing cross-client freshness suppression;
- dependency ordering, global-to-surface and same-surface dependency mapping, rejection of global-to-surface dependencies, and a four-provider concurrency limit;
- one second reserved for locked state/cache loading and planning, probe deduplication across checks and surfaces, reuse by exact probe key, at most eight concurrent probes, the seven-second probe sub-budget, deterministic schedule rejection, and timeout accounting remaining separate from provider `checkTimeoutMs`;
- provider deterministic-schedule validation, four-provider concurrency, the ten-second provider sub-budget, and two seconds reserved for cancellation, normalization, and atomic snapshot merge;
- enforcement of the resulting 20-second check phase, three-second start phase, 30-second readiness phase, five-second finalization phase, two-second shutdown margin, and 60-second overall lifetime;
- current-run completed or originally-completed still-fresh cached dependencies being accepted, while disabled, filtered, skipped, stale, timed-out, malformed, and failed dependencies suppress auto-start;
- provider Job Object cleanup terminating a forked child tree on timeout or runner exit;
- concurrent bounded stdout/stderr draining, UTF-8 handling, and flood-output truncation;
- atomic cache writes and recovery from a corrupt previous cache;
- identical-warning suppression and immediate reporting for changed warning sets;
- rejection of provider free-form messages, unknown reason/guidance codes, mismatched IDs, oversized facts, and excess keys;
- strict enforcement that provider results, registry fields, hook input, and context files cannot add to or alter the compiled auto-start policy;
- exact `\\LarkClaudeGateway` task-definition fingerprint validation for action count, executable, arguments, working directory, principal SID, logon type, run level, enabled state, execution limit, restart settings, and the complete expected trigger/action sets;
- task-definition drift suppressing auto-start and emitting `policy-task-definition-drift` with reinstall guidance even when the live gateway is healthy;
- successful fixed gateway scheduled-task start through the engine-owned helper; a single absolute three-second start deadline shared by deliberately slowed control-state revalidation, attempt-ledger persistence, helper creation, invocation, output draining, and cleanup; no helper when preflight consumes the deadline; termination of a hung helper at the remaining deadline; and a separate full 30-second readiness monitor polling health internally every 250 milliseconds without per-tick process creation;
- delayed listener readiness and inbox replay proving that `startedAt` is not used for PID identity, while immutable `processStartedAt` still matches the OS process start time;
- 45-second health freshness, 15-second future-clock tolerance, missing `processStartedAt`, stale pre-attempt health, and PID reuse remaining warning-only;
- one retry after a torn, empty, sharing-violating, or malformed `health.json` read, with a second failure or file over 64 KiB remaining warning-only;
- readiness task-state transitions requiring `Running` or `Queued` within three seconds and rejecting early return to `Ready`, disablement, disappearance, or unknown terminal state;
- exact `Ready`, `Running`, `Queued`, `Disabled`, missing, and unknown task-state behavior;
- `Ready` with a separately launched validated gateway returning `live-gateway-external-to-task`, `ok`, and `not-needed`;
- running-state task result codes not being misreported as completed failures;
- PID reuse, executable mismatch, process-start mismatch, stale/future health, clock skew, and ACL/read errors remaining warning-only;
- notification bootstrap failure never triggering the bootstrap task;
- token-meter drift never invoking its installer or repair script;
- token-meter directory permission checks using Windows `AccessCheck` without creating or deleting a probe file;
- Chrome DevTools MCP checks for pinned version, local paths, `--autoConnect`, optional status, and missing client configuration;
- Chrome, remote-debugging, MCP, proxy, dependency, and configuration failures remaining warning-only;
- JSON duplicate-key rejection and targeted edits preserving comments, encoding, newlines, ACLs, and unrelated hooks;
- optimistic hash conflicts aborting installation without overwriting concurrent changes;
- second-file replacement failure restoring the first file only while file identity and installed hash still match the just-installed candidate;
- concurrent edits after the first replacement being preserved, with an explicit manual-recovery diagnostic instead of rollback overwrite;
- exact owned-hook update/uninstall identity and refusal to remove similar or modified user hooks;
- `startup|resume` matching while `clear|compact|fork` do not trigger the runner;
- exact compatibility-matrix and async-capability gates refusing installation when any discovered shared-config consumer is unsupported;
- auto-start enablement refusing a gateway deployment that lacks `processStartedAt` support;
- installation initializing `mode.json` to `warn-only`, an update from `enabled` atomically returning to `warn-only` before it invalidates activation evidence, explicit atomic transition through `Enable-StartupHealthAutoStart.ps1`, and `warn-only`, pending activation, missing, unreadable, malformed, unknown-version, or unknown-value mode never creating the start helper;
- `mode=enabled` with deleted, corrupt, pending, stale, hash-mismatched, or failed-canary activation evidence suppressing the start helper and producing only a bounded control-state warning;
- shared-mutex serialization of enable, update, uninstall, rollback, and runner start decisions, including concurrent enable/update ordering and an already-running old-generation runner completing before an updater acquires the mutex;
- absent Claude or Codex configuration targets using guarded no-replace atomic creation with inherited parent ACLs, losing a create race without overwrite, and rollback deleting an installer-created file only while its identity and installed hash still match;
- rollback being able to return auto-start to `warn-only` while leaving checks installed and operational;
- full uninstall setting `warn-only`, removing only owned hooks, retaining and reporting all named runtime-state files, and marking the retained manifest uninstalled only after both removals succeed;
- no hook or provider result can emit a blocking decision or nonzero client-facing exit status;
- Codex and Claude adapters each emitting exactly one single-line JSON `systemMessage` envelope, never plain-text hook stdout or developer context, and omitting all control fields;
- warning rendering limited to eight segments and 1024 UTF-8 bytes with stable priority ordering, whole-segment omission, and a bounded `more-warnings` suffix, while JSON escaping and the trailing newline keep the complete envelope within 1280 UTF-8 bytes;
- `runner.log` rotation at 2 MiB with at most three rotated files, and bounded logs and results never containing fixture secrets, prompts, transcript text, Feishu identifiers, or browser URLs.

Manual acceptance verifies that Claude Code, Codex CLI, and the Codex desktop app become usable immediately while a deliberately stopped installed gateway starts in the background, and that a non-repairable failure produces one concise advisory without preventing normal work.

## Rollout And Rollback

Rollout first deploys the gateway's additive `processStartedAt` health-schema field through the normal gateway update path; the startup-health installer only validates that prerequisite and never rewrites the gateway. It then installs and validates the health scripts and pinned parser dependency, enumerates every shared-config consumer, verifies its exact version source and runtime ancestry, writes the approved runtime, registry, provider, diagnostic-probe, and task-definition identities and hashes to `install-manifest.json`, initializes `activation.json` to pending, and atomically initializes `mode.json` to `warn-only`. Only after those checks does it transactionally install the two user-level hooks.

Rollout then pauses for explicit Codex `/hooks` review and trust of the exact installed definition. The operator starts or resumes each required surface so actual warning-only invocations populate current activation evidence. Canary acceptance covers startup latency, immediate client termination, CLI/desktop surface classification, resume, simulated post-install client identity/version drift including an `app.asar`-only change, a fixture host that ignores `async`, malformed hooks, provider child-process cleanup, client-specific JSON warning envelopes, output delivery, a cold gateway startup lasting more than ten but less than 30 seconds, and a full all-surface snapshot. Existing feature installers and scheduled tasks remain unchanged.

After every required activation entry and warning-only canary passes, the operator explicitly runs `Enable-StartupHealthAutoStart.ps1`. Under the shared health/control mutex, the script revalidates hook hashes, activation evidence, all installed runtime and `app.asar` identities, gateway `processStartedAt` support, the installed manifest, and exact `\\LarkClaudeGateway` policy preconditions, then atomically changes only `mode.json` to `enabled`. Missing or invalid mode data always behaves as `warn-only`; the runner never infers enablement from registry or provider data.

An empty `%LOCALAPPDATA%\ai-startup-health\disabled` file is the immediate kill switch and makes every installed hook return silently with exit `0`. Full rollback runs the transactional health-hook uninstaller and removes only the exact owned Claude and Codex `SessionStart` entries. Partial uninstall restores its first edit if the second fails and retains backups on any rollback failure. Rollback does not stop any service, remove checked features, restore unrelated configuration, or delete health history.

Auto-start-only rollback atomically changes `mode.json` back to `warn-only` and leaves startup checks and advisory reporting active. Full rollback and partial uninstall use the same file-identity and installed-hash guards as installation: they restore a file only if it still matches the owned candidate, preserve any concurrent user or client edit, and report manual recovery when guarded restoration is no longer safe.

