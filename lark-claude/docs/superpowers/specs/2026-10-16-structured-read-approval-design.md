# Structured Read Approval Design

## Goal

Remove repetitive Lark approval round trips for commands that can be proven to
be read-only and confined to the registered project, including the PowerShell
wrapper form emitted by Codex on Windows. Preserve approval for commands whose
effects or file scope cannot be established statically.

## Current Failure

`isSafeReadCommand` matches a small regular expression against the beginning of
the rendered command. Codex commonly emits a command such as:

```text
"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'Get-Content -Raw .agents/docs/project-introduction.md'
```

The rendered command begins with `powershell.exe`, not `Get-Content`, so a safe
project-local read is rejected. Each rejected provider request becomes a
separate `RQ-*` approval and Lark round trip. The existing check also validates
the working directory but does not prove that path operands remain inside it.

## Selected Approach

Introduce a dedicated asynchronous read-policy classifier. It handles two
inputs:

1. Direct commands represented by Codex command metadata.
2. A fixed PowerShell wrapper whose script is supplied by one literal
   `-Command` argument.

PowerShell source is parsed, never executed, by a fixed local analyzer using
`System.Management.Automation.Language.Parser::ParseInput`. The gateway starts
that analyzer only with the canonical system Windows PowerShell executable and
the exact arguments `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass
-File <fixed-analyzer>`. `Bypass` is process-local and required because the host
policy otherwise blocks the fixed script; the script and host are integrity-
checked before the process starts.
It passes one bounded JSON request over stdin and the canonical project root as
a separate process argument. The analyzer returns one bounded JSON decision.
The executable and analyzer path are gateway-owned constants; neither can be
supplied by a Lark message or model command. Analyzer startup arguments are
independent of the target command's wrapper and compatibility mode.

At policy initialization the gateway canonicalizes the analyzer script and
every allowlisted PowerShell host, rejects any reparse point in their ancestor
chains, and records each regular file's SHA-256 digest. Automatic read approval
is disabled if any protected file lies inside a registered writable project
root. Immediately before every analyzer or profile-discovery spawn, the gateway
repeats canonicalization and digest checks; a changed, missing, inaccessible,
or reparse-backed file fails closed. Automatic file-change approval always
rejects a target equal to a protected analyzer, host, or profile path.

The authoritative v2 approval payload is `params.command`, because the
generated app-server schema describes it as the command to execute.
`params.commandActions` is only a best-effort display parse. Auto-approval
requires `kind` to be absent or `command`, one non-empty string `command`, one
project-local `cwd`, no requested additional permissions or network context,
and exactly one `commandActions` entry. Its `command` must byte-match the inner
script. A `read` action is accepted only for one `Get-Content` AST and its path
must equal the analyzer's canonical path; a `listFiles` action is accepted only
for one `Get-ChildItem` AST with the same path. An `unknown` action is permitted
only because the AST analyzer remains authoritative; a `search` action is
rejected. A captured fixture from the installed app-server proves that the
accepted `Test-Path` plus `Get-Content` conditional is represented as exactly
one aggregate `unknown` action containing the complete script, including when
the tested leaf is absent. For this fixture, corroboration requires exactly
`type=unknown`, the byte-identical complete script, and no `path` property; its
type is not compared with the analyzer's `conditional` kind. Path comparison
applies only to `read` and `listFiles`. Missing or multiple actions fail closed.

The app-server does not expose a Windows command line. Codex official source
shows that it produces `params.command` by applying Rust `shlex::try_join` to
the exact argv vector and then redacting recognizable secrets. A live probe of
the installed app-server confirms this representation and confirms that the
single `commandActions[].command` value contains the inner PowerShell source.
The classifier ports the decoder and encoder behavior of the producer's pinned
Rust `shlex` crate version 1.3.0. It decodes the complete outer command once,
re-encodes the argv with the same `try_join` algorithm, and requires byte-for-
byte equality with `params.command`. This rejects valid but noncanonical POSIX
quoting, comments, or escapes that the producer would not emit. It also rejects
malformed input, NULs, and the only replacement emitted by the applicable
`redact_secrets` function, `[REDACTED_SECRET]`, before decoding. It does not
apply `CommandLineToArgvW` or PowerShell parsing to the outer string.

The normal wrapper contract is an exact canonical gateway-owned
`powershell.exe` or `pwsh.exe` path, optional `-NoLogo`, mandatory `-NoProfile`,
optional `-NonInteractive`, then exactly one `-Command` and one script argv
element. This includes the observed Codex form `-NoProfile -Command <script>`.
Switches are matched by their full names; abbreviations, duplicates, encoded
commands, stdin commands, files, and trailing arguments are rejected. The
decoded script must byte-match the sole accepted `commandActions[].command`
before it is sent to the AST analyzer. The action's type and canonical path
must also match the analyzer result when it is `read` or `listFiles`; the exact
aggregate `unknown` exception is defined above. The best-effort action is
corroboration, not an independent authority.

Codex currently emits both Windows PowerShell and its bundled `pwsh` without
`-NoProfile` or `-NonInteractive`, and the official Codex configuration
reference exposes no shell-argv setting that can add them. A narrowly scoped
compatibility contract therefore accepts the same fixed wrapper grammar without
`-NoProfile` only after the per-request profile check below. `-NoLogo` and
`-NonInteractive` remain optional and ordered. The allowlist contains the
canonical system Windows PowerShell path and, when present, the one canonical
`pwsh.exe` resolved from the gateway's startup environment. Bare names and any
other PowerShell binary are rejected.

Compatibility is enabled for a host only when every applicable all-users and
current-user profile for that exact host is absent. Profile paths are discovered
at policy initialization by invoking the allowlisted host with `-NoProfile
-NonInteractive`; Windows PowerShell's four standard paths are also checked
against fixed expected locations. The classifier canonicalizes and checks the
profile paths and their deepest existing parents immediately before every
decision. Any existing, inaccessible, reparse-point, changed, or unexpected
profile path rejects compatibility mode. Compatibility is disabled for the
entire gateway if a profile path lies inside any registered writable project
root. Automatic file-change approval also always rejects a change targeting a
known profile path. The local administrator-controlled host remains the trust
boundary; races caused by a separate privileged process are out of scope.

The policy is fail closed. A timeout, malformed output, parse error, oversized
input, unexpected request shape or AST, inaccessible path, profile uncertainty,
or ambiguous argument produces `safe=false` and retains the existing approval
workflow.

## Accepted Grammar

The analyzer accepts only a deliberately small AST subset. The complete root
`ScriptBlockAst` must contain no `using` statements, attributes, `param` block,
requirements, dynamic parameters, begin/process/clean blocks, or traps. Its end
block contains only:

- one pipeline containing one command and no redirection;
- or one `if` statement with no `elseif`/`else`, whose condition is one
  `Test-Path` command and whose body is one accepted read command;
- literal `StringConstantExpressionAst` command names and arguments only;
- no variables, interpolation, subexpressions, invocation operators, command
  expressions, script blocks as values, assignments, functions, aliases with
  mutable meaning, dot sourcing, traps, loops, or background execution.

Only full canonical cmdlet names are accepted; aliases and parameter
abbreviations are rejected. The initial invocation table is:

- `Get-Content [-Raw] [-LiteralPath] <one-path>`; positional path or
  `-LiteralPath` is accepted, while `-Path`, multiple paths, streams, encodings,
  delimiters, tails, waits, filters, and credentials are rejected.
- `Get-ChildItem [-Force] [-LiteralPath] <zero-or-one-path>`; no recurse, depth,
  filters, includes/excludes, names, attributes, providers, or multiple paths.
- `Test-Path [-LiteralPath] <one-path> [-PathType Leaf|Container|Any]`; no
  filters, includes/excludes, credentials, providers, or multiple paths.
- `Resolve-Path [-LiteralPath] <one-path>`; no relative output, credentials,
  providers, or multiple paths.

Common parameters, stop-parsing tokens, splatting, and repeated parameters are
rejected. The `if` form must test and read the exact same literal path, apart
from optional `Get-Content -Raw`; its condition cannot use unary/binary
operators and its body cannot contain additional statements.

External commands are not auto-approved in this phase. In particular, `rg`,
`git`, and `where.exe` return `safe=false`: environment/config processing,
preprocessors, hooks, textconv, pagers, filesystem monitors, and executable
shadowing mean their absence of side effects cannot be proved from the rendered
argv alone. This intentionally replaces the existing broad regex allowances.

## Path Policy

The provider-supplied `cwd` must resolve within the canonical registered
project. Every operand classified as a filesystem path is resolved relative to
that `cwd`. `Get-Content`, `Get-ChildItem`, and `Resolve-Path` operands must
exist; the target and every ancestor are canonicalized so junctions and
symlinks cannot escape the project. `Test-Path`, including the exact conditional
`Test-Path`/`Get-Content` form, may name one absent leaf: the analyzer walks to
the deepest existing ancestor, requires it to canonicalize inside the project,
and rejects a missing intermediate segment below a reparse point. The
conditional still requires both commands to use the exact same literal path.
Wildcards and recursive reads are rejected. Provider-qualified paths, UNC
paths, device paths, alternate data streams, home expansion, environment
expansion, and parent traversal are rejected.

Reading `.agents`, `.codex`, and other project-local hidden directories is
allowed. A similarly named directory under the user profile or another project
is not.

## Gateway Integration

`CodexExecutor` awaits the classifier when it receives
`item/commandExecution/requestApproval`. A positive decision responds
`accept` immediately and produces no Lark approval. A negative or unavailable
decision follows the current `onApproval` path unchanged.

The classifier result is boolean plus a bounded internal reason code. Command
text and resolved paths are not added to logs. No approval is cached across
commands because path contents, profile files, working directories, and process
state can change between requests. The analyzer validates the complete request
shape and the exact `command` bytes; it does not reconstruct an executable
payload from `commandActions`.

Before spawning the analyzer, the JavaScript boundary rejects a UTF-8
`params.command` over 8 KiB, an inner script over 4 KiB, more than eight decoded
argv elements, any argv element over 4 KiB, or serialized analyzer input over
16 KiB. The analyzer stdin schema is exactly
`{version:1,script:string,cwd:string}`; the canonical project root is a separate
fixed process argument. Its stdout must be one JSON line no larger than 4 KiB
with exactly `{version:1,safe:boolean,reason:string,action:object|null}` and a
reason from the fixed enum `safe_read`, `safe_list`, `safe_test`,
`safe_resolve`, `safe_conditional`, `invalid_request`, `parse_error`,
`unsupported_ast`, or `unsafe_path`. A safe action is exactly
`{kind:"read"|"listFiles"|"test"|"resolve"|"conditional",path:string|null}`;
the five `safe_*` reasons require `safe=true` and the correspondingly named
action kind. `invalid_request`, `parse_error`, `unsupported_ast`, and
`unsafe_path` require `safe=false` and `action:null`. Any other cross-field
combination, unknown field, or extra field fails closed. Any stderr output is a
failure. The child has a 2,000 ms deadline; on expiry the gateway forcibly
terminates it, waits at most 250 ms for close, discards all output, and returns
`safe=false`. The analyzer never spawns descendants.

Project-local non-delete file changes remain automatically accepted except for
every protected analyzer, PowerShell host, and profile path, which is always
approval-gated. Source-control commits, deletes, network operations, builds
with unknown hooks, package installation, and arbitrary scripts remain
approval-gated.

## Failure Handling

- Analyzer startup failure, timeout, nonzero exit, invalid JSON, or excessive
  output returns `safe=false`.
- Parser diagnostics or unsupported AST nodes return `safe=false`.
- A path that cannot be proven project-local returns `safe=false`.
- The gateway never treats classifier failure as task failure; it asks the user
  for approval through the existing durable `RQ-*` mechanism.

## Tests

Automated coverage includes:

- the five observed project-local commands, including the conditional
  `.codex/memory/MEMORY.md` read, are accepted;
- canonical quoted Windows PowerShell compatibility wrappers are accepted only
  while all fixed profile paths are absent;
- canonical `pwsh.exe` compatibility wrappers are accepted only while all
  profiles discovered for that host are absent;
- canonical `pwsh.exe` and `powershell.exe` wrappers with exact
  `-NoProfile -Command` and `-NoProfile -NonInteractive -Command` arguments are
  accepted;
- POSIX shlex decoding is tested against Codex's quoted-path, single-quoted,
  double-quoted, embedded-quote, and malformed output forms;
- shlex tests use the Rust `shlex` 1.3.0 fixtures, require exact decode/re-encode
  equality, and reject valid POSIX strings that are noncanonical `try_join`
  output as well as `[REDACTED_SECRET]`;
- noncanonical/bare executables, host-argument abbreviations, extra switches,
  redacted commands, existing/inaccessible/reparse-point profiles, profile
  paths inside a registered writable project, automatically proposed profile
  file changes, and command/action mismatches are rejected;
- analyzer/host paths inside writable projects, changes targeting protected
  analyzer/host files, and missing, reparse-backed, or SHA-256-changed protected
  files disable automatic read approval;
- captured action fixtures assert one `read` action for simple `Get-Content`
  and one aggregate `unknown` action for the exact conditional; missing,
  multiple, `search`, wrong-script, wrong-type, and wrong-path actions fail;
- project-relative and canonical in-project absolute paths are accepted;
- `..` escape, outside absolute paths, junction escape, UNC/device/provider
  paths, environment variables, interpolation, subexpressions, all wildcards,
  and recursive reads are rejected;
- pipelines, redirections, separators, assignments, functions, aliases,
  invocation operators, nested script blocks, root requirements, `using`,
  parameter abbreviations, common parameters, and write commands are rejected;
- direct external commands including `rg` and read-only `git` remain
  approval-gated;
- analyzer timeout, crash, malformed JSON, and oversized input fall back to one
  normal approval;
- 8 KiB command, 4 KiB script/argument, eight-argv, 16 KiB stdin, 4 KiB stdout,
  and 2,000 ms deadline boundaries are tested at limit and one unit over;
- analyzer output tests cover every allowed safe/failure tuple and reject
  mismatched booleans, reasons, action kinds, nullability, and extra fields;
- analyzer launch tests assert the exact canonical host and mandatory
  `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File` prefix,
  including while a normal user profile exists;
- executor tests prove accepted reads never call `onApproval`, while rejected
  and classifier-error cases call it exactly once.

## Operational Verification

Run the complete Node test suite and `git diff --check`, restart
`LarkClaudeGateway`, then verify a Lark-driven Codex task can read the five
project instruction files without any `RQ-*` message. A later source-control
commit or another mutating command must still request approval.
