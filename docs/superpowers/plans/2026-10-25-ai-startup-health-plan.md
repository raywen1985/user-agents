# AI Client Startup Health Implementation Plan

## Basis And Constraints

- Implement the approved design in `docs/superpowers/specs/2026-10-24-ai-startup-health-design.md`.
- Keep all reusable paths repository-relative or resolve them at installation from `UserProfile`, `LocalApplicationData`, and the script directory. Never commit a machine-specific absolute path.
- Preserve unrelated working-tree changes. In particular, treat current edits under `hooks/`, `token-meter/`, and `claude-projects/lark/` as user-owned and integrate with their current contents.
- Use test-first increments. Offline tests operate only on temporary profiles, fake scheduled tasks, fixture processes, and injected clocks unless a task explicitly says it is a live canary.
- Do not install hooks, trust Codex hooks, enable auto-start, start Chrome, send Feishu messages, or modify the live gateway task during ordinary automated tests.
- Commit each task separately after its focused tests and `git diff --check` pass. Do not stage unrelated files.

The unavailable `writing-plans` skill is replaced by this repository-local implementation plan after the user approved the design.

## Task 1: Add The Gateway Process-Start Health Contract

Files:

- Add `claude-projects/lark/src/gateway-health.mjs`.
- Add `claude-projects/lark/test/gateway-health.test.mjs`.
- Modify `claude-projects/lark/src/gateway.mjs`.
- Modify `claude-projects/lark/test/gateway.test.mjs` only where integration coverage is needed.

Steps:

1. Add failing tests that convert the existing Windows `procStart` FILETIME value into an immutable RFC 3339 UTC `processStartedAt`, reject malformed or out-of-range values, and keep it stable across later health writes.
2. Extract bounded health-document construction into `gateway-health.mjs` so it can be tested without starting the listener.
3. Capture `processStartedAt` immediately after the existing self-process probe and before listener startup or inbox replay. Retain `procStart` for backward compatibility and retain `startedAt` as readiness time.
4. Include `processStartedAt` in startup, heartbeat, shutdown, and restart health documents without changing existing gateway task behavior.
5. Run the focused gateway tests and the full gateway suite.

Verification:

```powershell
Set-Location claude-projects/lark
node --test test/gateway-health.test.mjs test/gateway.test.mjs
npm test
```

## Task 2: Establish The Framework Skeleton And Portable State Model

Files:

- Add `startup-health/README.md`.
- Add `startup-health/checks.json`.
- Add `startup-health/StartupHealth.psm1`.
- Add `startup-health/tests/Test-StartupHealth.ps1`.
- Add `startup-health/tests/fixtures/` entries for valid and invalid registries and state files.

Steps:

1. Write failing tests for portable repository-root discovery, `%LOCALAPPDATA%\ai-startup-health` resolution, fixed state filenames, schema versions, atomic sibling-file replacement, bounded quarantine names, and log rotation.
2. Implement strict registry parsing: duplicate IDs, identifier grammar, canonical provider paths, reparse points, alternate streams, dependency cycles, scope mapping, numeric bounds, reason/guidance catalogs, and compiled policy IDs.
3. Implement normalized provider result parsing with the exact status, execution outcome, `startEligibility`, `dependencyReady`, fact-count, string-size, and total-size limits.
4. Implement atomic JSON state helpers for `latest.json`, `last-notified.json`, `start-attempts.json`, `activation.json`, `mode.json`, and `install-manifest.json`.
5. Add a portability test that scans reusable framework files for committed usernames or drive-letter paths.

Verification:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\startup-health\tests\Test-StartupHealth.ps1 -Group Foundation
git diff --check -- startup-health
```

## Task 3: Implement The Shared Mutex, Budgets, And Process Isolation

Files:

- Modify `startup-health/StartupHealth.psm1`.
- Add `startup-health/tests/fixtures/provider-*.ps1`.
- Extend `startup-health/tests/Test-StartupHealth.ps1`.

Steps:

1. Add failing tests for the SID-derived global mutex, its `SYNCHRONIZE | MUTEX_MODIFY_STATE` ACL, zero-wait runner behavior, bounded control-command waiting, abandoned ownership, and a second process opening, acquiring, releasing, and closing the mutex.
2. Implement one shared health/control mutex used by the runner, installer, enable command, uninstaller, and rollback paths.
3. Add a Windows Job Object wrapper using `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, concurrent UTF-8 stdout/stderr draining, 64 KiB stream caps, and guaranteed handle cleanup.
4. Add a monotonic deadline abstraction and tests for the 20-second check phase, absolute three-second start phase, 30-second readiness phase, five-second finalization phase, two-second shutdown margin, and 60-second hard lifetime.
5. Test slow preflight, slow ledger writes, hung helpers, child-process trees, flood output, and cancellation. Confirm no helper starts when preflight consumes the start deadline and readiness always receives its independent reservation.

Verification:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\startup-health\tests\Test-StartupHealth.ps1 -Group Concurrency,Processes,Budgets
```

## Task 4: Build Runtime Discovery And The 500 Millisecond Entry Guard

Files:

- Add `startup-health/Invoke-StartupHealthHook.ps1`.
- Add runtime and ASAR helpers to `startup-health/StartupHealth.psm1`.
- Add `startup-health/tests/fixtures/runtime-manifests/`.
- Extend `startup-health/tests/Test-StartupHealth.ps1`.

Steps:

1. Add fixture tests for Claude `2.1.252`, standalone Codex CLI `0.153.4`, desktop embedded Codex `0.163.0-alpha.10.2`, and desktop internal build `26.1013.40934` without embedding local installation paths in source.
2. Implement bounded ancestor-process inspection and canonical file identity comparison. Classify desktop only when the approved embedded runtime, approved `app.asar`, internal build, and `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=Codex Desktop` agree.
3. Implement the no-child-process, no-network guard. Check `disabled` first, then the exact owned-handler projection, runtime identity, and `app.asar` identity under the 500 millisecond deadline.
4. Fail closed with exit `0` for missing, duplicate, reformatted, drifted, upgraded, ambiguous, or unsupported hook/runtime identities. Never load providers, cache, or auto-start state after guard failure.
5. Cover `async`-only drift, timeout-only drift, spoofed desktop environment values, `app.asar`-only updates, a host fixture that ignores `async`, and kill-switch precedence.

Verification:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\startup-health\tests\Test-StartupHealth.ps1 -Group RuntimeGuard
```

## Task 5: Implement Diagnostic Probes And The Provider Scheduler

Files:

- Modify `startup-health/StartupHealth.psm1`.
- Extend `startup-health/checks.json`.
- Add `startup-health/tests/fixtures/probes/`.
- Extend `startup-health/tests/Test-StartupHealth.ps1`.

Steps:

1. Add failing tests for fixed `version-output`, pinned JSON parser, and Codex configuration-validation profiles. Reject shells, metacharacter interpretation, dynamic arguments, configurable working directories, inherited stdin, executable drift, and unapproved profiles.
2. Implement probe deduplication by profile, executable identity, exact arguments, and surface, with up to eight concurrent probes and one seven-second aggregate deadline.
3. Implement provider dependency scheduling with global/surface mapping, four-provider concurrency, a ten-second aggregate deadline, and two seconds for cancellation, normalization, and snapshot merge.
4. Enforce deterministic schedule validation at install time so a registry whose worst-case critical path cannot fit is rejected.
5. Implement per-provider/surface freshness, the 60-second gateway TTL, five-minute default TTL, dependency-closure refresh, atomic generation merge, and conservative handling of corrupt/future-dated state.

Verification:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\startup-health\tests\Test-StartupHealth.ps1 -Group Probes,Scheduler,Cache
```

## Task 6: Add Read-Only Dependency, Configuration, Token Meter, And Notification Providers

Files:

- Add `startup-health/checks/runtime-dependencies.ps1`.
- Add `startup-health/checks/config-integrity.ps1`.
- Add `startup-health/checks/token-meter.ps1`.
- Add `startup-health/checks/lark-notify.ps1`.
- Extend `startup-health/checks.json` and provider fixtures/tests.

Steps:

1. Write protocol tests for each provider before implementation, including valid `dependencyReady` behavior and exact reason/guidance IDs.
2. Make runtime dependencies consume broker-produced version facts rather than invoking executables directly.
3. Make configuration integrity consume the pinned JSON/JSONC and Codex validation results, detect duplicate owned hooks, and expose no file content or secrets.
4. Check Token Meter scripts, owned hooks, status-line configuration, manifests, and data-directory rights through Windows `AccessCheck`; never create a write probe or run repair/install scripts.
5. Check Feishu notification scripts, `lark-cli`, Claude/Codex notification configuration, native bridge state, and the `LarkNotifyBootstrap` task. Treat `Running`/`Queued` task result codes as active rather than failed and never trigger the bootstrap task.
6. Run the provider AST policy test to reject file mutation, direct task/process/service start, package installation, and dynamic invocation.

Verification:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\startup-health\tests\Test-StartupHealth.ps1 -Group ProviderContract,Dependencies,ConfigIntegrity,TokenMeter,LarkNotify
```

## Task 7: Add Gateway Health And The Only Compiled Auto-Start Policy

Files:

- Add `startup-health/checks/lark-gateway.ps1`.
- Add fixed gateway policy helpers to `startup-health/StartupHealth.psm1`.
- Extend `startup-health/checks.json` and gateway fixtures/tests.

Steps:

1. Add fixtures for fresh, stale, future-dated, torn, oversized, malformed, inaccessible, and PID-reused health documents plus every scheduled-task state.
2. Validate `processStartedAt` against the live process start time, canonical Node executable, PID, `listenerReady`, `stopping`, 45-second freshness, and 15-second future tolerance. Retry a transient health-file read exactly once after 100 milliseconds.
3. Map `Running`, `Queued`, `Ready`, `Disabled`, missing, and unknown states exactly as specified. Return `ok/live-gateway-external-to-task/not-needed` for a validated external gateway.
4. Fingerprint the complete installed `LarkClaudeGateway` task definition against the installation manifest. Emit `policy-task-definition-drift` and suppress auto-start on any mismatch, including when a gateway process is healthy.
5. Add the engine-owned fixed start helper for exactly `\LarkClaudeGateway`; accept no task parameters. Before invocation, revalidate mode, activation, hook projection, manifest generation, dependencies, cooldown, task definition, and absence of a live gateway under the shared mutex.
6. Persist the attempt before invocation, use only the remaining absolute start-phase time, then run one in-process 250 millisecond readiness loop for at most 30 seconds. Require `Running`/`Queued` within three seconds and a new validated health document no older than the attempt.

Verification:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\startup-health\tests\Test-StartupHealth.ps1 -Group Gateway,AutoStartPolicy,Readiness
```

## Task 8: Add Chrome DevTools MCP And Model Proxy Providers

Files:

- Add `startup-health/checks/chrome-devtools-mcp.ps1`.
- Add `startup-health/checks/model-proxy.ps1`.
- Extend `startup-health/checks.json` and provider fixtures/tests.

Steps:

1. Test the pinned Chrome DevTools MCP package, entry script, lockfile consistency, Claude configuration, Codex `mcp_servers.chrome-devtools`, `enabled`, non-required status, exact command/arguments, and `--autoConnect`.
2. Check only local Chrome presence, remote-debugging evidence, and available client status. Never launch Chrome, enable debugging, call an MCP tool, or rewrite MCP configuration.
3. Extract only a loopback proxy endpoint and perform a short unauthenticated TCP-connect check. Never expose credentials or send a model request.
4. Confirm both providers are warning-only and cannot select an auto-start policy.

Verification:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\startup-health\tests\Test-StartupHealth.ps1 -Group ChromeDevToolsMcp,ModelProxy
```

## Task 9: Implement Reporting, Deduplication, And Client Envelopes

Files:

- Modify `startup-health/StartupHealth.psm1`.
- Modify `startup-health/Invoke-StartupHealthHook.ps1`.
- Extend reporting fixtures/tests.

Steps:

1. Render messages only from digest-pinned reason/guidance catalogs; never interpolate provider text, facts, paths, environment values, prompts, transcripts, Feishu identifiers, or browser URLs.
2. Sort warnings by severity and registry order, retain at most eight segments and 1024 UTF-8 payload bytes, omit whole segments, and add a bounded `more-warnings` count.
3. Emit exactly one client-specific single-line JSON envelope using top-level `systemMessage`, with no control fields or plain-text stdout. Keep the escaped envelope plus newline within 1280 UTF-8 bytes.
4. Implement 30-minute per-surface identical-warning suppression independent of provider freshness. Quarantine and recreate a corrupt notification ledger while treating the current set as new.
5. Keep healthy startup silent and always exit `0` for provider, cache, rendering, or output errors.

Verification:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\startup-health\tests\Test-StartupHealth.ps1 -Group Reporting,Envelopes
```

## Task 10: Build The Transactional Installer And Config Editor

Files:

- Add `startup-health/Install-StartupHealth.ps1`.
- Add `startup-health/tools/config-editor.mjs`.
- Add `startup-health/tools/package.json` and `startup-health/tools/package-lock.json` with a pinned `jsonc-parser`.
- Add installer fixtures and Node/PowerShell tests under `startup-health/tests/`.

Steps:

1. Test JSON/JSONC targeted edits for comments, indentation, newlines, final newline, encoding, duplicate-key rejection, unrelated hooks, and exact owned-handler projection hashes.
2. Enumerate every discovered Claude, standalone Codex, embedded desktop Codex, and applicable shared-config consumer. Resolve absolute paths only at install time and store them in the untracked local manifest.
3. Require every consumer to match the exact compatibility matrix and native async-hook canary before touching either user hook file. Validate the gateway `processStartedAt` prerequisite, registry/provider/probe digests, schedule budgets, and fixed task fingerprint.
4. Stage both hook candidates with `startup|resume`, `async: true`, timeout `75`, and owner `AIStartupHealthV1`. Validate both through the pinned parser and available native client validators.
5. Under the shared mutex, downgrade an update to `warn-only`, recheck source identities/hashes, atomically replace or no-replace-create both files, preserve ACL/encoding, and guard rollback by installed identity and hash.
6. Write the local manifest and pending activation evidence while still holding the mutex. On partial failure, preserve concurrent user/client edits and report manual recovery instead of overwriting them.
7. Confirm installer tests use temporary profiles exclusively and never touch live client configuration.

Verification:

```powershell
Set-Location startup-health/tools
npm test
Set-Location ../..
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\startup-health\tests\Test-StartupHealth.ps1 -Group Installer
```

## Task 11: Add Activation, Enablement, Uninstall, And Rollback Commands

Files:

- Add `startup-health/Enable-StartupHealthAutoStart.ps1`.
- Add `startup-health/Uninstall-StartupHealth.ps1`.
- Extend `startup-health/StartupHealth.psm1`, README, and tests.

Steps:

1. Record per-surface activation only after a real warning-only invocation passes the runtime guard and acquires the mutex. Bind evidence to the exact owned-handler projection and complete runtime-manifest generation.
2. Make enablement hold the shared mutex and reject missing, corrupt, pending, stale, hash-mismatched, or failed-canary evidence, gateway schema drift, runtime drift, hook drift, and task-policy drift.
3. Cover concurrent enable/update ordering and an old-generation runner finishing before an updater acquires the mutex. Revalidate all control state immediately before any start helper.
4. Make auto-start-only rollback atomically set `warn-only` while leaving checks installed.
5. Make full uninstall set `warn-only`, remove only exact owned hooks transactionally, retain named audit/history state, and mark manifest/activation uninstalled only after both removals succeed.
6. Document the Codex `/hooks` trust step, required one-time warning-only launch of each surface, kill switch, enable command, rollback, retained files, and recovery messages.

Verification:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\startup-health\tests\Test-StartupHealth.ps1 -Group Activation,Enablement,Uninstall,Rollback
```

## Task 12: Run Full Offline Regression And A Controlled Warning-Only Canary

Files:

- Add `startup-health/tests/Test-StartupHealthCanary.ps1`.
- Update `startup-health/README.md` with the exact rollout checklist and observed compatible versions.
- Modify implementation files only for defects revealed by this task.

Steps:

1. Run all startup-health tests, existing Token Meter tests, Feishu notification/bootstrap tests, and the complete gateway test suite.
2. Run portability and diff checks; confirm no reusable file contains this machine's username, drive letter, resolved executable path, secrets, or local IDs.
3. Run installer `-WhatIf`/preflight against the live machine and inspect the compatibility report without modifying hooks.
4. Perform the explicit warning-only install. Review and trust the exact Codex hook through `/hooks`, then start/resume Claude, standalone Codex, and desktop once to populate activation evidence.
5. Verify each client becomes usable immediately; the entry guard stays within 500 milliseconds; no plain stdout becomes context; warnings are bounded; and `latest.json` contains the complete snapshot.
6. Deliberately stop the already-installed gateway task, run the warning-only checks, and confirm no start occurs before enablement. Then run `Enable-StartupHealthAutoStart.ps1`, repeat once, and verify background start plus readiness without delaying the client.
7. Exercise kill switch, auto-start-only rollback, and re-enable. Do not run full uninstall unless rollback behavior needs investigation.
8. Record the exact verified runtime identities in the local untracked manifest, not in portable source. Commit only source, tests, lockfile, and documentation.

Verification:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\startup-health\tests\Test-StartupHealth.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\token-meter\Test-TokenMeter.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\hooks\test-lark-notify.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\hooks\test-codex-notify-bridge.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\hooks\test-lark-notify-bootstrap.ps1
Set-Location claude-projects/lark
npm test
Set-Location ../..
git diff --check
```

## Completion Criteria

- Claude Code CLI, standalone Codex CLI, and Codex desktop startup remain immediately usable under healthy, warning, timeout, corrupt-state, unsupported-version, and failed-start scenarios.
- Token Meter, Feishu notification, Feishu remote gateway, Chrome DevTools MCP, model proxy, dependencies, and configuration integrity checks all produce bounded normalized results.
- Only the exact installed and fingerprint-matched `LarkClaudeGateway` task can auto-start, and only after explicit activation and enablement.
- A new read-only check can be added through one provider, registry entry, bounded catalogs, and tests without changing hook entry points or orchestration code.
- All automated suites pass, the controlled canary passes, and no unrelated working-tree changes are staged or reverted.
