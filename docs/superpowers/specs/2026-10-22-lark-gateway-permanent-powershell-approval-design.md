# Lark Gateway Permanent PowerShell Approval

## Goal

Allow every command-execution approval whose outer executable is a trusted Windows PowerShell or PowerShell 7 host to run without a Feishu approval round trip. The choice persists across Gateway restarts and applies across every Gateway task, session, and project.

This mode intentionally permits PowerShell scripts to read or modify any path, delete data, change system configuration, access credentials, start processes, and use the network. It is equivalent to granting the allowed Feishu sender remote PowerShell execution through the Gateway. It does not create an operating-system-wide PowerShell policy and does not affect PowerShell launched outside this Gateway.

## Configuration And Rollback

Add an optional, validated Gateway configuration field:

```json
"powershellApprovalMode": "always_allow"
```

The only accepted values are:

- `review`: preserve the current classifier and Feishu approval behavior;
- `always_allow`: automatically accept every structurally valid request whose outer executable is one of the trusted PowerShell hosts captured at Gateway startup.

Missing persisted configuration is normalized to `review` for backward compatibility. Unknown values fail Gateway startup. Returning the field to `review` and restarting the Gateway is the rollback mechanism.

The setting is process-wide and remains active until configuration is changed. It is not a task grant, has no expiry, and is not stored in the approval database.

## Trusted Host Identification

The Gateway continues to consume the structured Codex App Server command-approval payload. It canonical-decodes the RPC command with the existing Rust shlex 1.3 decoder and compares the first argument against the canonical startup paths of:

- `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
- an installed `pwsh.exe` discovered through the existing trusted-host initialization.

The host files are canonicalized, required to be regular non-link files, and hashed at startup through the existing protected-file policy. Automatic acceptance requires the current host file to retain the same canonical path and digest. A relative executable, alias, command text mentioning PowerShell, copied or shadowed executable, malformed command encoding, or host whose identity changed after startup fails closed into the normal approval path.

Structural validity for permanent approval depends only on receiving the command-execution approval RPC method and canonically decoding `params.command` to an argument vector whose first argument is a trusted host. `commandActions` is not part of this decision. Missing, empty, multiple, unknown, or contradictory semantic actions are ignored in `always_allow` mode because the user selected trust in the outer PowerShell host regardless of inner behavior.

`networkApprovalContext`, `additionalPermissions`, and equivalent command-scoped permission metadata do not disqualify a trusted PowerShell host. They are accepted as part of the same command decision without producing another RQ prompt. The Gateway does not interpret or narrow those permissions in `always_allow` mode.

In `always_allow` mode, once the trusted outer host is proven, the Gateway deliberately does not inspect or restrict the remaining arguments or inner script. `-Command`, `-File`, `-EncodedCommand`, profiles, nested processes, pipelines, redirection, dynamic evaluation, project escapes, protected paths, destructive commands, and network activity are all allowed. This is the requested machine-wide PowerShell capability.

## Execution Flow

`ReadApprovalPolicy` exposes a separate trusted-host decision rather than overloading the existing safe-operation classifier. It returns structured evidence such as:

```js
{
  trustedPowerShellHost: true,
  executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
}
```

`CodexExecutor` processes command approvals in this order:

1. Validate the command payload and trusted outer host.
2. If `powershellApprovalMode` is `always_allow` and the host is trusted, durably write the bounded audit event.
3. If the audit write succeeds, respond `accept` immediately.
4. If the audit write fails, respond `decline` or fail the turn immediately; do not run the safe-operation classifier, task grants, or RQ creation for that request.
5. If permanent approval did not match, run the current operation classifier and task-grant logic.
6. If no policy accepts the request, create the existing RQ approval.

An accepted permanent PowerShell request never creates an approval row, waiter, outbox prompt, or Feishu message. Existing pending RQ rows are not retroactively approved.

File-change approval events and commands whose outer executable is not a trusted PowerShell host retain their existing policy. A trusted PowerShell script can nevertheless perform those same mutations internally without another approval, which is an intentional consequence of this mode.

## Sender And Session Boundary

The existing Gateway ingress controls remain unchanged:

- only P2P messages are accepted;
- the sender must be in `allowedOpenIds`;
- Session selection and project authority checks still determine where a task starts;
- task cancellation, worker timeout, and native Session ownership checks remain active.

These controls reduce accidental routing but are not security containment once `always_allow` is enabled. Compromise of an allowed Feishu account, bot credential, router, prompt, or resumed Session can lead to arbitrary execution on the PC.

## Audit Logging

Every permanently accepted PowerShell request writes one bounded structured audit event containing:

- event name `powershell_auto_approved`;
- task ID and Gateway Session ID;
- canonical executable path;
- the approval request ID when supplied by the RPC protocol;
- timestamp.

The log must not contain the raw command, arguments, command length, hashes or HMACs derived from the command, environment, output, tokens, or credentials. Audit logging failure does not reveal command contents and terminates this approval path with `decline` or a turn error. It must never fall through to another classifier, task grant, or Feishu approval prompt.

## Deployment

Configuration and code changes require a Gateway restart. Restarting while a task is running or waiting for approval interrupts that task under the existing recovery policy, so deployment uses an atomic drain/admission handshake rather than an external status snapshot.

The deploy command creates a fixed restart-request marker inside the Gateway run directory. The running Gateway observes it on its existing control timer, installs an in-process admission fence before inspecting scheduler activity, and stops the Lark listener so no new task can pass the fence. It then yields through already-entered message handlers and rechecks active, waiting, and queued scheduler state:

- if any work exists, it removes the fence and marker, restarts the listener, records `restartDeferred=true` in health, and leaves the process running;
- if no work exists, it records `restartReady=true` in health and exits cleanly without aborting a task.

The deploy command starts the scheduled task only after observing the old process exit with `restartReady=true`. A task arriving before the fence is visible in the fenced recheck and defers activation; a message arriving after the fence cannot enter task creation. Inbox rows accepted immediately before the fence but not yet processed remain replayable after restart. Timeouts or malformed marker state remove the marker, restore the listener when possible, and fail deployment without killing the process.

After restart, verify a new Gateway PID, `listenerReady=true`, and exactly one active Feishu consumer. A pre-existing pending RQ is not a valid activation test because restart expires interrupted approval state; use a new task.

## Testing

Tests must cover:

- missing mode defaults to `review`, both supported values load, and unknown values fail startup;
- `always_allow` accepts arbitrary `-Command`, `-File`, and `-EncodedCommand` requests for each trusted host without invoking the approval callback;
- trusted-host requests remain accepted when `commandActions` is missing, empty, multiple, unknown, or contradictory;
- network and additional-permission metadata on a trusted PowerShell request remain automatically accepted and create no RQ;
- destructive, project-external, protected-path, registry, scheduled-task, credential, and network PowerShell examples are accepted in this explicitly unsafe mode;
- the same requests still require normal approval in `review` mode;
- relative, shadowed, copied, linked, missing, replaced, or malformed PowerShell hosts are not permanently accepted;
- text that merely mentions `powershell.exe` cannot trigger automatic acceptance;
- non-PowerShell command approvals and file-change approvals retain current behavior;
- permanent acceptance creates no approval, waiter, outbox row, or Feishu prompt;
- each accepted command produces one bounded audit event containing only identifiers, executable, optional RPC request ID, and timestamp;
- audit failure returns `decline` or a turn error and cannot fall through to a classifier, grant, or RQ;
- task grants, SVN validation, Session routing, voice handling, stop handling, and existing single-request approvals continue to pass regression tests;
- the admission fence catches a task that arrives between the initial deployment request and restart decision, removes the fence, and defers activation without interrupting that task;
- an idle fenced Gateway exits cleanly and activates the new process with one listener and one consumer.
