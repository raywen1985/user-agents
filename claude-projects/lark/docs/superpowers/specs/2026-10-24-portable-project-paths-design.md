# Portable Project Paths Design

## Objective

Make the Lark gateway repository reusable after it is copied or cloned to a
different Windows user profile or directory. Tracked project files must not
contain machine-specific absolute paths when a relative path, automatic
discovery, or a machine-local override can represent the same value.

Absolute paths remain required at operating-system boundaries such as process
launch, filesystem validation, and Scheduled Task registration. Those paths
must be discovered and materialized by installation logic, not committed as
portable project configuration.

## Scope

This change covers reusable files under `claude-projects/lark`:

- gateway and project policy configuration;
- configuration loading and path resolution;
- installation and startup scripts;
- project-level Claude Code settings;
- ignore rules, documentation, and focused tests.

Historical design documents are not rewritten. Test fixtures that deliberately
use fictional absolute Windows paths to exercise path identity, containment, or
security behavior remain absolute.

## Configuration Model

The gateway uses two configuration layers:

1. Tracked base files contain portable values:
   `config/gateway.json` and `config/projects.json`.
2. Ignored machine-local files contain installation results:
   `config/gateway.local.json` and `config/projects.local.json`.

The loader merges base configuration first and local configuration second.
Objects are merged by supported configuration section, while arrays are
replaced rather than concatenated. This keeps allowlists and project policies
deterministic and prevents duplicate entries. Unknown or malformed local keys
fail validation instead of being silently ignored.

Paths in tracked configuration that refer to repository resources are resolved
against the Lark project root. Machine-local executable and external project
paths are supplied by the local layer. All paths are normalized to canonical
absolute paths before use by process launch, project identity, security checks,
or filesystem access.

The portable base project policy contains no external machine path. A fresh
installation may leave the local project list empty because the gateway can
discover projects from verified Claude Code and Codex history. Explicit local
aliases and excluded roots belong in `config/projects.local.json`.

## Installer Responsibilities

`scripts/install-task.ps1` derives the project root from `$PSScriptRoot`. It
discovers Node.js, Claude, Lark CLI, FFmpeg, and SVN through `Get-Command` plus
bounded, platform-appropriate fallback locations. Codex retains its existing
`auto` resolution unless the installer is explicitly given an override.

Before changing the installation, the script verifies every required
executable and prepares the complete local configuration in memory. Generated
JSON is written to a temporary file in the destination directory and then
atomically moved into place. A discovery or validation failure leaves the
previous local configuration and Scheduled Task unchanged and reports each
missing dependency with a remediation hint.

The installer registers `LarkClaudeGateway` with resolved absolute values for
the Node executable, gateway entry point, and working directory. These absolute
values are installation artifacts and are not copied back into tracked files.

The installer is idempotent. Re-running it refreshes managed paths without
duplicating configuration or permission entries.

## Claude Code Settings

`.claude/settings.json` contains only portable, project-relative permissions.
Machine-specific permissions are written to the ignored
`.claude/settings.local.json` during installation.

When updating local settings, the installer preserves existing keys and
permission entries it does not manage. It updates only the exact executable and
filesystem permission entries derived from the current installation. Managed
entries from a previous installer run are recorded in ignored installation
state so stale source-machine paths can be removed safely without pattern-based
deletion of user rules.

The repository ignore rules explicitly exclude the two local configuration
files, Claude local settings, and installer state.

## Runtime Loading

`src/config.mjs` owns configuration composition and validation. Scripts that
need executable paths use the same resolved configuration contract rather than
reading a single JSON file directly. Startup therefore behaves the same from a
shell and from the Scheduled Task.

The loader reports actionable errors for these cases:

- the installer has not produced required local executable paths;
- a configured executable no longer exists;
- a local project path is missing or invalid;
- a relative repository path escapes the project root;
- local and base configuration have incompatible types;
- project aliases or roots conflict after composition.

Security-sensitive Codex control paths retain their existing fixed-root and
absolute-path checks. Runtime session `cwd` values and canonical project
identities also remain absolute after validation.

## Migration

Current machine-specific executable values move from `gateway.json` to the
ignored local override. The `D:\\WA\\unity_asset` alias override moves from
`projects.json` to the ignored local project policy. The tracked base files are
left portable.

Existing `.claude/settings.local.json` content is treated as local state. The
portable subset is moved to `.claude/settings.json`; machine-specific entries
remain local and become installer-managed where applicable. No unrelated user
permission is removed.

Installation is not automatically executed as part of the source edit, and the
running gateway is not restarted. The user can review the generated behavior
and run the installer explicitly when ready.

## Verification

Focused automated tests cover:

- base and local configuration precedence;
- array replacement and invalid type rejection;
- project-root-relative path resolution and escape rejection;
- missing or stale executable diagnostics;
- installer discovery and atomic local configuration generation;
- idempotent Claude settings updates that preserve unmanaged entries;
- migration of the current configuration shape.

The complete Node test suite must pass. A read-only dry run of installer
discovery verifies the current machine without rewriting the Scheduled Task or
restarting the gateway. A final repository scan checks reusable source,
configuration, scripts, and current documentation for source-machine paths,
while allowing the documented test-fixture and historical-design exceptions.
