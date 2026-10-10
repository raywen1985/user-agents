# Codex Executable Auto-Resolution Design

Date: 2026-10-10
Status: Approved for planning

## Problem

The Lark gateway stores an absolute path to the Codex executable in
`config/gateway.json`. The ChatGPT desktop app installs Codex under a
version-specific hash directory. Desktop updates can remove the old directory,
leaving the gateway with a stale path and causing every Codex task to fail with
`spawn ... ENOENT`.

The message listener, router, queue, and session creation are healthy. The
failure occurs only when the gateway spawns Codex.

## Goals

- Keep Codex tasks working across ChatGPT desktop app updates.
- Prefer the desktop-bundled Codex so the gateway tracks the app's current
  runtime.
- Preserve an explicit absolute-path override for controlled installations.
- Fall back to the globally installed Codex CLI when the desktop binary is not
  available.
- Fail at gateway startup with actionable diagnostics when no valid executable
  can be found.

## Non-Goals

- Installing or updating Codex automatically.
- Changing Claude, Node.js, or lark-cli executable resolution.
- Changing routing, approval, sandbox, queue, or session behavior.
- Depending on shell command parsing to launch Codex.

## Considered Approaches

### Fixed global CLI path

Point the gateway at the native executable inside the global npm package. This
path survives desktop updates, but it separates the gateway runtime from the
desktop app version and still depends on npm package layout.

### Desktop discovery only

Scan the desktop app's hash directories on every gateway startup and select the
current `codex.exe`. This tracks desktop updates but offers no recovery when the
desktop installation is unavailable or its layout changes.

### Hybrid resolution

Support explicit absolute paths and an `auto` mode. In `auto` mode, discover a
desktop executable first and use the global CLI native executable as a fallback.
This is the selected approach because it combines current desktop behavior with
a stable secondary source.

## Configuration Contract

`gateway.executables.codex` accepts either:

- An absolute path, which remains an exact operator override and must exist.
- The string `auto`, which enables deterministic discovery.

Other executable fields continue to require existing absolute paths. The shipped
configuration changes only the Codex field to `auto`.

## Resolution Algorithm

At gateway startup:

1. If the configured value is an absolute path, validate that it is an existing
   regular file and use it without discovery.
2. If the value is `auto`, scan
   `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`.
3. Keep only existing regular files directly matching that fixed directory
   shape. If multiple candidates exist, choose the one with the newest file
   modification time; use the normalized absolute path as a deterministic
   tie-breaker.
4. If no desktop candidate exists, check the known native executable location
   under the global npm package rooted at `%APPDATA%\npm\node_modules\@openai`.
5. If no candidate exists, throw a startup error that names the configured mode
   and every fixed location that was checked.

The resolver returns an absolute native `.exe` path. It never returns a `.cmd`
or PowerShell wrapper and never invokes a shell.

## Components

### Configuration loader

`src/config.mjs` will expose a small resolver with injectable environment roots
for tests. `loadConfig()` will resolve the Codex value before applying the
existing executable validation loop, then replace `gateway.executables.codex`
with the resolved absolute path. Downstream executors remain unchanged.

### Documentation and configuration

`config/gateway.json` will use `"codex": "auto"`. `README.md` will document the
new Codex-only value, discovery priority, explicit override behavior, and the
startup failure mode.

### Runtime diagnostics

Startup logging will include the resolved Codex executable path. Errors will not
silently select an invalid wrapper or defer discovery failures until a task is
already queued.

## Security and Failure Handling

- Discovery is limited to fixed per-user Codex installation roots.
- Candidates must be regular files named `codex.exe`.
- The process is spawned directly with an argument array and no shell.
- An explicit path never silently falls back; a bad override is treated as an
  operator error.
- `auto` mode fails closed when neither trusted location contains a candidate.
- Existing approval and project-boundary controls are unchanged.

## Testing

Unit tests will cover:

- A valid explicit absolute path is preserved.
- An invalid explicit path fails and does not fall back.
- `auto` selects the newest desktop candidate.
- Desktop candidate tie-breaking is deterministic.
- `auto` falls back to the global native CLI executable.
- `auto` reports all checked locations when no candidate exists.
- Non-Codex executable fields retain their absolute-path validation.

Verification will run the repository test suite, load the real configuration,
confirm the selected executable reports a version and supports `app-server`,
restart `LarkClaudeGateway`, and check its health/log output. The final end-to-end
check is a new Feishu Codex task; success means the task progresses beyond spawn
and returns a normal Codex result or an ordinary approval request.

## Rollout and Recovery

The change takes effect only after restarting the gateway process. If automatic
resolution behaves unexpectedly, set `gateway.executables.codex` back to a known
absolute executable path and restart. No session database migration is needed,
and queued/session records remain compatible.
