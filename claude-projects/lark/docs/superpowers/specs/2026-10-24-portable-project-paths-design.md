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

The loader merges base configuration first and local configuration second. It
uses the following schema-defined rules rather than a generic JSON merge:

- scalar fields in the local layer replace the corresponding base scalar;
- `executables` and `voice` merge one named property at a time so an omitted
  local property preserves the base value;
- `codexControl` is replaced as one complete section when present locally;
- `allowedOpenIds`, `projects`, and `excludedRoots` are replaced as complete
  arrays when present locally;
- `null` is not a deletion marker and is rejected for every typed field; and
- unknown properties and object/array type mismatches are rejected.

The base files must satisfy every machine-independent required field. The
local files are optional syntactically, but normal gateway startup fails with
an instruction to run the installer when a required executable has no valid
resolved value. An explicitly disabled optional integration remains valid
without a local value.

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
discovers Node.js, Claude, Lark CLI, FFmpeg, and SVN using this deterministic
precedence: an explicit installer parameter, known product installation roots,
then a unique `Get-Command -CommandType Application` result. Codex retains its
existing `auto` resolution unless the installer is explicitly given an
override. Discovery never accepts aliases, functions, PowerShell scripts,
batch shims, or an ambiguous set of application candidates.

Every selected program is canonicalized and must be an existing regular
`.exe` file whose path and parent chain contain no reparse point. The installer
runs a bounded capability probe before accepting it: Node.js, Claude, FFmpeg,
and SVN must return recognizable version output; Lark CLI must return its
expected help or version identity. An explicit override changes search
precedence, not validation. This permits the known user-level Claude and Lark
install roots without trusting an arbitrary PATH shadow. Discovery tests cover
PATH shadowing, non-Application commands, reparse points, invalid binaries, and
multiple valid candidates.

Before changing the installation, the script verifies every required
executable and prepares all generated files in memory. It acquires a single
installation lock and creates a recovery journal containing byte-for-byte
backups of each destination plus the prior Scheduled Task XML, if any. All new
files are written and validated as same-directory temporary files before the
first replacement.

The commit order is local gateway configuration, local project policy, Claude
local settings, installer ownership state, Scheduled Task registration, task
start, and bounded health verification. Any caught failure restores the files
and prior task from the journal. A process interruption may leave a journal;
the next installer run restores that recorded generation before beginning new
discovery. Only successful health verification removes the journal and
backups. Thus atomic file replacement is combined with transaction-level
recovery rather than presented as cross-file atomicity. A discovery or
validation failure occurs before the journal and reports each missing
dependency with a remediation hint.

The installer registers `LarkClaudeGateway` with resolved absolute values for
the Node executable, gateway entry point, and working directory. These absolute
values are installation artifacts and are not copied back into tracked files.

The installer is idempotent. Re-running it refreshes managed paths without
duplicating configuration or permission entries. Fault-injection tests cover
each replacement, task registration, task start, and health-check boundary and
verify restoration on both an immediate failure and the next-run recovery path.

## Claude Code Settings

`.claude/settings.json` contains only portable, project-relative permissions.
Machine-specific permissions are written to the ignored
`.claude/settings.local.json` during installation.

When updating local settings, the installer preserves existing keys and
permission entries it does not manage. The ignored ownership state has a schema
version, installation generation, and the exact permission strings added by a
successful installer generation. On later runs, only exact strings owned by
the previous state are eligible for removal before the new strings are added.

When no prior ownership state exists, the installer performs conservative
first-run adoption: it preserves every preexisting local permission, adds the
new managed permissions, and records ownership only for entries it actually
added. It does not infer ownership from path patterns, so stale paths that
predate the installer may remain until the user removes them. This is the only
way to preserve the guarantee that unrelated user permissions are not deleted.

The repository ignore rules explicitly exclude the two local configuration
files, Claude local settings, and installer state.

## Runtime Loading

`src/config.mjs` owns full configuration composition and validation. Portable
`scripts/start.ps1` handles the unavoidable Node bootstrap: it reads only the
`executables.node` value from the local gateway override, applies the same
regular-file, `.exe`, canonicalization, and no-reparse checks, and launches the
Node entry point. The Node loader then performs the authoritative full merge
and validation. The Scheduled Task uses the same installer-resolved Node path,
entry point, and project root, so shell and scheduled startup converge before
gateway initialization without requiring Node to discover Node.

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

Tracked source is also part of the portability boundary. The hard-coded SVN
default and `C:\\Windows` fallback in `src/read-approval-policy.mjs` are removed.
SVN is supplied by validated resolved configuration, and a missing `SystemRoot`
or `SYSTEMROOT` fails closed when the trusted PowerShell host cannot be derived.

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
- transaction rollback and interrupted-install recovery at every commit phase;
- idempotent Claude settings updates that preserve unmanaged entries;
- conservative first-run settings adoption and exact later ownership cleanup;
- migration of the current configuration shape.

The complete Node test suite must pass. A read-only dry run of installer
discovery verifies the current machine without rewriting the Scheduled Task or
restarting the gateway. A final repository scan checks reusable source,
configuration, scripts, and current documentation for source-machine paths,
while allowing the documented test-fixture and historical-design exceptions.
A source test scans tracked runtime/configuration/script files for drive-qualified
literals and permits only a small reviewed allowlist; documentation and path
semantics fixtures are checked separately so new runtime fallbacks cannot hide
in the broad historical exceptions.
