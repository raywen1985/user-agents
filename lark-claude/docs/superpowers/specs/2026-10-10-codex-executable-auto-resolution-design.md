# Codex Executable Auto-Resolution Design

Date: 2026-10-10
Status: Approved for implementation planning

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
- Recover when a desktop update happens while the gateway is already running.
- Prefer the desktop-bundled Codex so the gateway tracks the app's current
  runtime.
- Preserve an explicit absolute-path override for controlled installations.
- Fall back to the globally installed Codex CLI when the desktop binary is not
  available.
- Fail before worker launch with actionable diagnostics when no valid executable
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

Scan the desktop app's hash directories before worker launch and select the
current `codex.exe`. This tracks desktop updates but offers no recovery when the
desktop installation is unavailable or its layout changes.

### Hybrid resolution

Support explicit absolute paths and an `auto` mode. In `auto` mode, discover a
desktop executable first and use the global CLI native executable as a fallback.
This is the selected approach because it combines current desktop behavior with
a stable secondary source.

## Configuration Contract

`gateway.executables.codex` accepts either:

- An absolute path to a regular file named `codex.exe`. This is an exact
  operator override: it must pass validation and capability preflight, and it
  never falls back to another installation.
- The exact string `auto`, which enables deterministic discovery.

Relative paths, wrapper scripts, other strings, and non-string values are
rejected with a configuration error. A custom npm prefix or nonstandard install
must use the explicit absolute-path form.

Other executable fields continue to require existing absolute paths. The shipped
configuration changes only the Codex field to `auto`.

## Resolution Algorithm

The resolver runs before every new Codex worker is spawned. This is required
because the long-running gateway can outlive a desktop update. Successful
capability checks may be cached by canonical path, file size, and modification
time, but desktop candidate enumeration still occurs for every worker so a new
installation is noticed immediately.

For an explicit path, the resolver requires a non-link regular file, resolves
its canonical absolute path, and preflights that exact file. A failure is fatal
for the task and does not enter auto discovery.

For `auto` mode:

1. If `LOCALAPPDATA` is set, canonicalize
   `%LOCALAPPDATA%\OpenAI\Codex\bin` and enumerate its direct child directories
   with `fs.readdir`/`Dirent`. Do not recursively search elsewhere.
2. Reject child directories and executable entries that are symbolic links or
   junctions according to `lstat`/`Dirent`. Canonicalize every surviving
   `codex.exe` with `realpath` and require it to remain contained by the
   canonical bin root.
3. Keep only regular files named exactly `codex.exe`. Inspection failures are
   recorded per candidate; `ENOENT` is treated as an update race and other
   errors are retained in diagnostics before continuing.
4. Sort desktop candidates by numeric `mtimeMs` descending. Break ties by the
   lower-cased normalized absolute path in ascending JavaScript code-unit order,
   then by the original normalized path in ascending code-unit order.
5. Preflight candidates in that order. File modification time is only a
   deterministic approximation of the most recently installed runtime; the
   desktop app exposes no stable active-version pointer in this installation.
6. If all desktop candidates fail, check one architecture-specific native npm
   path under the default per-user npm prefix:
   - `x64`: `%APPDATA%\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe`
   - `arm64`: `%APPDATA%\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-arm64\vendor\aarch64-pc-windows-msvc\bin\codex.exe`
7. If `APPDATA` is unset, `process.arch` is unsupported, or the npm candidate
   fails validation, record why the fallback was skipped or rejected. Validate
   the npm file with `lstat`, reject links, canonicalize the default npm root and
   candidate, and require canonical containment under that root.
8. If no candidate passes, throw an error listing the configured mode, roots and
   exact fallback path checked, plus bounded candidate rejection reasons.

Preflight spawns the native executable directly as `codex.exe app-server
--help`, with `windowsHide: true`, no shell, and a five-second timeout. Success
requires exit status zero and the expected `codex app-server` usage marker. In
auto mode a failed or timed-out candidate is rejected and resolution continues;
an explicit override fails closed.

After resolution, worker startup uses the returned absolute native `.exe` path.
If spawn reports `ENOENT` before app-server initialization completes, the auto
resolver invalidates that candidate, performs discovery again, and retries once.
The retry prevents a desktop-update race between preflight and spawn without
creating an unbounded restart loop. Other errors and explicit-path failures are
reported immediately.

## Components

### Configuration loader

`src/config.mjs` will validate the Codex configuration contract separately from
the existing absolute-path fields. It will preserve `auto` as a runtime mode
instead of replacing it once at gateway startup.

### Codex executable resolver

A focused `src/codex-executable.mjs` module will own candidate enumeration,
canonical containment checks, ordering, preflight, bounded diagnostics, and the
one-retry invalidation behavior. Filesystem, environment, architecture, clock,
and preflight operations will be injectable so tests do not launch Codex.

### Gateway and executor

`src/gateway.mjs` will construct the resolver and pass a resolve callback to the
Codex executor. `src/executors/codex.mjs` will resolve immediately before worker
spawn and retry initialization once only when auto mode encounters initial
`ENOENT`. Routing, sessions, and approval logic remain unchanged.

### Documentation and configuration

`config/gateway.json` will use `"codex": "auto"`. `README.md` will document the
new Codex-only value, discovery priority, explicit override behavior, and the
worker-launch failure mode.

### Runtime diagnostics

Logging will report the selected source (`explicit`, `desktop`, or `npm`) and
resolved path when that selection changes. Errors will not silently select an
invalid wrapper. Candidate diagnostics are bounded and contain paths and OS
error categories, not environment contents.

## Security and Failure Handling

- Discovery is limited to fixed per-user Codex installation roots and the exact
  architecture-specific default npm path.
- Auto-discovered candidates must be non-link regular files named `codex.exe`,
  and their canonical paths must stay inside the canonical discovery root.
- The process is spawned directly with an argument array and no shell.
- An explicit path never silently falls back; a bad override is treated as an
  operator error.
- Auto mode skips missing environment roots, records permission and race errors,
  and fails closed when no candidate passes validation and preflight.
- Existing approval and project-boundary controls are unchanged.

## Testing

Unit tests will cover:

- A valid explicit absolute path is preserved.
- Relative, non-string, wrapper, wrong-name, missing, directory, and invalid
  explicit values fail and do not fall back.
- `auto` selects the newest desktop candidate.
- Desktop candidate tie-breaking is deterministic.
- Desktop symlinks/junctions and canonical paths outside the fixed root are
  rejected.
- Candidate disappearance, permission errors, corrupt binaries, missing
  `app-server` support, and preflight timeouts are diagnosed and skipped.
- Missing `LOCALAPPDATA` and `APPDATA` are handled without constructing relative
  paths.
- `auto` checks the exact x64 and arm64 npm paths for the matching architecture
  and rejects unsupported architectures.
- `auto` reports all checked locations and bounded rejection reasons when no
  candidate exists.
- A running gateway notices a newly installed desktop candidate before the next
  task.
- Initial auto-mode `ENOENT` invalidates discovery and retries exactly once;
  explicit mode and other failures do not retry.
- Non-Codex executable fields retain their absolute-path validation.

Verification will run the repository test suite, load the real configuration,
confirm the selected executable reports a version and supports `app-server`,
restart `LarkClaudeGateway`, and check its health/log output. The final end-to-end
check is a new Feishu Codex task; success means the task progresses beyond spawn
and returns a normal Codex result or an ordinary approval request.

## Rollout and Recovery

The configuration/code change takes effect after one gateway restart. Future
desktop updates do not require restarts because each new Codex worker resolves
again. If automatic resolution behaves unexpectedly, set
`gateway.executables.codex` to a known absolute native `codex.exe` path and
restart. No session database migration is needed, and queued/session records
remain compatible.
