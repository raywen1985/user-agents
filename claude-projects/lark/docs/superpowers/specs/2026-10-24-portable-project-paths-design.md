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
expected help or version identity. Node.js must report a semantic version that
satisfies the package requirement `>=24`; incompatible versions are rejected
before the recovery journal or task is changed. An explicit override changes
search precedence, not validation. This permits the known user-level Claude and
Lark install roots without trusting an arbitrary PATH shadow. Discovery tests
cover PATH shadowing, non-Application commands, reparse points, invalid
binaries, incompatible Node versions, and multiple valid candidates.

Before changing the installation, the script verifies every required
executable and prepares all generated files in memory. It refuses to mutate an
installation while the existing gateway task or its recorded process is
running, so an install cannot interrupt active sessions or mistake an old
process for the new installation. The user must stop the gateway first.

The script then acquires a single installation lock and constructs recovery
state in a new, non-reparse generation directory. Backups are created before
any destination replacement. A versioned manifest uses fixed logical target
IDs, not journal-supplied filesystem paths, and records for each file either an
absent-target tombstone or a backup filename, byte length, and SHA-256 digest.
It also records whether the Scheduled Task was absent or stores its exported
XML, digest, and stopped state. Every backup is read back and verified.

The manifest is first written as a pending file and is atomically renamed to
the active journal only after every backup and all proposed same-directory
temporary files validate. No destination changes before that rename. A crash
during construction can therefore leave only an uncommitted pending directory,
which the next run validates as uncommitted and removes without restoration. An
active journal is restored only after its version, logical targets, lengths,
and digests validate. A corrupt or incomplete active journal fails closed and
requires explicit manual recovery; it never deletes or overwrites destinations.

The commit order is local gateway configuration, local project policy, Claude
local settings, installer ownership state, Scheduled Task registration, task
start, and bounded health verification. The installer creates a unique
installation generation, writes it into the local gateway configuration, and
includes it as an explicit gateway command argument in the Scheduled Task.
The gateway copies that generation, its canonical Node executable, canonical
entry point, PID, and process-start identity into health state. Installation
succeeds only when health reports the expected generation and paths and the PID
and start identity match the newly created live process. Stale health is never
accepted.

Any caught failure stops only a process whose PID, start identity, and
installation generation match the process started by this transaction, then
restores the files and prior task from the journal. Because a previously
running installation is rejected before mutation, the prior task state is
either stopped or absent and is restored in that state. A process interruption
may leave an active journal; the next installer run validates and restores that
recorded generation before beginning new discovery. Only successful bound
health verification removes the journal and backups. Thus atomic file
replacement is combined with transaction-level recovery rather than presented
as cross-file atomicity. A discovery or validation failure occurs before the
journal and reports each missing dependency with a remediation hint.

Active-journal recovery always runs before the ordinary existing-gateway
rejection. The journal records the proposed task action, including its unique
generation argument. After task start, the installer waits for either bound
health or a unique process whose canonical executable and complete command
arguments match the journaled Node path, entry point, and generation. Once
found, PID and process-start identity are atomically published in a versioned
process-identity sidecar before health verification continues.

On next-run recovery, the installer classifies the current Scheduled Task
before touching it. Absence is valid. An exact XML/digest match with the
journaled prior stopped task is also valid and is left stopped. An exact match
with the proposed task is disabled to prevent future starts but is not stopped
yet. Any task matching neither the prior nor proposed definition fails closed.

Recovery then locates the transaction process while its identity evidence is
still available. A live process named by the sidecar must match PID, start
identity, executable, entry point, and generation. If that PID has exited or
been reused, recovery does not stop the new occupant and instead performs the
same bounded generation query used when no sidecar exists. The query requires a
unique process with the journaled executable and complete generation-bearing
command line. Multiple matches or any live identity mismatch fails closed.
Zero matches is safe because the proposed task has already been disabled or was
never registered. One validated match is rechecked by PID and start identity,
stopped directly, and observed exiting before any file or task restoration.
Only then does recovery restore the prior task definition or remove a task that
was previously absent. This covers crashes before task registration and hard
termination immediately after task start, both before and after the first bound
health write, without destroying identity evidence or restoring files beneath
an unidentified live process.

The installer registers `LarkClaudeGateway` with resolved absolute values for
the Node executable, gateway entry point, and working directory. These absolute
values are installation artifacts and are not copied back into tracked files.

The installer is idempotent. Re-running it refreshes managed paths without
duplicating configuration or permission entries. Fault-injection tests cover
each replacement, task registration, task start, and health-check boundary and
verify restoration on both an immediate failure and the next-run recovery path.
Tests also cover interruption during journal construction, a corrupt active
journal, stale health, a preexisting running gateway, and health failure after
the exact new process starts. Hard-interruption cases cover the interval after
task start both before and after the first generation-bound health write.

## Claude Code Settings

`.claude/settings.json` contains only portable, project-relative permissions.
Machine-specific permissions are written to the ignored
`.claude/settings.local.json` during installation.

The tracked settings allowlist is intentionally exact and minimal:

- `Bash(npm test *)`;
- `Bash(node --test test/*.test.mjs)`;
- `Bash(powershell -NoProfile -ExecutionPolicy Bypass -File scripts/stop.ps1)`;
- `WebSearch`; and
- `WebFetch(domain:open.feishu.cn)`.

Only an existing local entry that exactly matches this table moves to tracked
settings during source migration. Broad commands such as `Bash(node *)`,
package installation, process/PID diagnostics, filesystem reads, program
discovery, temporary paths, and every absolute executable rule remain local
and unmanaged unless the installer adds an exact machine permission it owns.
Portability alone never promotes a permission into the tracked allowlist.

The installer-generated local permission table is also exact. Angle-bracketed
values below are substituted only from validated installation paths:

- `Bash("<lark-cli>" im *)`;
- `Bash("<lark-cli>" --help)`;
- `Bash("<lark-cli>" schema *)`;
- `Bash("<lark-cli>" api *)`;
- `Bash(MSYS_NO_PATHCONV=1 "<lark-cli>" skills list)`;
- `Read(<claude-bin-directory>/**)`;
- `Read(<local-app-data>/Temp/voice-test/**)`; and
- `Bash(MSYS_NO_PATHCONV=1 "<lark-cli>" api POST
  /open-apis/speech_to_text/v1/speech/file_recognize --data
  '@<local-app-data>\\Temp\\voice-test\\pcm-body.json' --as bot 2>&1 | head -12)`.

Paths are rendered in Claude Code's required slash and escaping form after
canonical validation. The installer grants no package-install, generic
filesystem, PID/process diagnostic, arbitrary executable, or broader command
permission. Preexisting local entries outside this table remain preserved and
unmanaged. Later cleanup removes only exact rendered strings recorded in the
previous successful ownership state.

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
default and fixed Windows-directory fallback in `src/read-approval-policy.mjs`
are removed.
SVN is supplied by validated resolved configuration, and a missing `SystemRoot`
or `SYSTEMROOT` fails closed when the trusted PowerShell host cannot be derived.

## Migration

Current machine-specific executable values move from `gateway.json` to the
ignored local override. The current external-project alias override moves from
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
- generation-bound health checks and exact new-process rollback;
- hard-interruption recovery before and after the first health write;
- idempotent Claude settings updates that preserve unmanaged entries;
- conservative first-run settings adoption and exact later ownership cleanup;
- the exact tracked Claude permission migration table;
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
