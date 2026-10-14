# CC Switch Internal Skill Design

Date: 2026-10-14
Status: Approved for implementation

## Problem

The Feishu gateway needs one registered, project-independent `ccswitch`
internal skill that can answer questions about the locally installed CC Switch
application. Token usage is the first requested capability, but the skill must
be a stable namespace for related CC Switch queries instead of a one-off
`token_usage` registration.

The installed application is CC Switch Desktop 3.20.1. The upstream project
documents that the desktop application is GUI-only. It has no supported
management HTTP API, CLI, or headless interface. Its local routing server is an
LLM request proxy, not a provider-management API. The `ccswitch://` deep-link
surface imports configuration and is not a query interface. A separately
maintained community CLI can share the database, but it is not installed and
its supported database version may lag behind the desktop application.

CC Switch stores its state in `~/.cc-switch/cc-switch.db`. Therefore the first
version of the gateway skill will use a defensive, read-only SQLite adapter.

## Goals

- Register one allowlisted `ccswitch` internal skill with controlled query
  subcommands.
- Provide an overview of the local CC Switch installation and data freshness.
- List providers and identify the current provider for each supported app.
- Report provider health without exposing raw upstream errors.
- Report local-routing status and configured listen address.
- Summarize token usage, request success, cache tokens, and estimated cost for
  today, yesterday, the last 7 days, or the last 30 days.
- Group usage by app, provider, and model while keeping Feishu output bounded.
- Make later read-only or mutating CC Switch operations additive without
  widening the first release's permissions.

## Non-Goals

- Returning API keys, authentication tokens, OAuth credentials, cookies, or
  the raw `settings_config`, `auth`, `env`, backup, or account payloads.
- Returning request bodies, prompts, response bodies, session IDs, file paths,
  or raw provider error messages.
- Switching providers, editing providers, enabling or disabling routing,
  changing failover queues, importing deep links, or writing the CC Switch
  database in the first release.
- Installing or depending on the community `cc-switch-cli`.
- Calling the local LLM proxy as though it were a management API.
- Accepting SQL, filesystem paths, provider IDs, model names, ports, or other
  free-form arguments from a Feishu message.
- Reproducing every CC Switch dashboard or promising compatibility with an
  unknown future database schema.

## Selected Approach

Add `ccswitch` to the existing static internal-skill registry. The router emits
one controlled `ccswitch_action` enum and, only for usage queries, one
controlled `usage_period` enum. The resolver rejects mixed project work,
unknown operations, forbidden fields, and arbitrary content before dispatch.

The handler delegates to a focused `CcSwitchReader` that opens the fixed local
database in read-only mode, verifies its identity and schema, runs only fixed
parameterized queries, converts rows into non-secret domain records, and then
closes the connection. A formatter produces bounded Chinese output.

This is a gateway internal skill, not a Codex `SKILL.md` package. It follows the
gateway's source allowlist and structured intent contract so CC Switch access
cannot become a general local command facility.

## Capability Model

The first release supports five subcommands:

- `overview`: application/database version, latest usage timestamp, current
  providers, and routing summary.
- `providers`: provider name, app type, current flag, category/type, and safe
  connection metadata when it can be extracted through an allowlist.
- `health`: healthy/unhealthy state, consecutive failure count, and bounded
  success/failure timestamps. Raw `last_error` is never returned.
- `routing_status`: per-app enabled state, proxy-enabled state, loopback/listen
  address, port, logging, failover, and live-takeover state.
- `usage`: token and cost totals for one controlled period, with app/provider/
  model breakdowns.

Unsupported verbs such as switch, enable, disable, edit, delete, import,
export, reveal key, or show token are rejected with a fixed response explaining
that the installed skill is read-only.

Future mutating functions must be designed as separate controlled subcommands
with exact target references, revalidation, idempotency, audit, and explicit
confirmation. They may not inherit permission from this read-only release.

## Routing Contract

The intent schema keeps `action: internal_skill`, adds `ccswitch` to the static
`skill_name` enum, and adds two nullable fields:

- `ccswitch_action`: `overview`, `providers`, `health`, `routing_status`,
  `usage`, or the rejection-only sentinel `unsupported_mutation`.
- `usage_period`: `today`, `yesterday`, `last_7_days`, or `last_30_days`.

For `ccswitch`, executor, project alias, session reference, session name,
request reference, and content must all be null. `ccswitch_action` must be one
of the registered values. `usage_period` is required only for `usage`; when the
message asks for usage without a period, the router sets `today`. It must be
null for every other action. For every action or skill other than `ccswitch`,
both CC Switch fields must be null. The schema requires both fields on every
intent so stale or mixed router output cannot inherit a CC Switch operation.

`unsupported_mutation` is valid router output but is never dispatched to the
reader. The resolver accepts it only when every common internal-skill field is
null and immediately returns the fixed read-only limitation. This gives switch,
enable, disable, edit, delete, import, export, and credential-reveal requests a
structured rejection path without widening the dispatch allowlist.

Examples:

- `查看 CC Switch 状态` -> `overview`
- `CC Switch 当前用了哪个 provider` -> `providers`
- `查看 CC Switch provider 健康状态` -> `health`
- `CC Switch 本地路由是否开启` -> `routing_status`
- `查询 CC Switch 今天 token 消耗` -> `usage`, `today`
- `CC Switch 最近七天用量` -> `usage`, `last_7_days`

Messages that combine a CC Switch query with project work clarify instead of
silently dropping either intent. A request for an unsupported mutation returns
the read-only limitation rather than being routed to a coding session.

## Database Discovery and Validation

The reader derives the database only from the process owner's home directory:
`~/.cc-switch/cc-switch.db`. The path never comes from a message. Before
opening it, the reader requires:

- the `.cc-switch` root and database to exist;
- the root and database not to be symbolic links or reparse points;
- the database to be a regular file no larger than 512 MiB;
- the canonical database path to remain directly below the canonical fixed
  root.

The WAL is limited to 256 MiB and the SHM file to 64 MiB; main, WAL, and SHM
must remain within 768 MiB combined. Exceeding a bound returns
`resource_limit` before SQLite open.

The adapter opens the canonical live database itself with SQLite's native
read-only flag. It does not copy the main file and does not use immutable mode,
because either approach can silently omit committed WAL frames. If
`cc-switch.db-wal` or `cc-switch.db-shm` exists, each sidecar must be a regular,
non-reparse file directly under the same validated root; a malformed sidecar
fails closed. A WAL without an existing valid SHM fails as `read_unavailable`
rather than allowing SQLite to create auxiliary state. SQLite, rather than
application code, discovers and reads valid sidecars. It may acquire locks and
update the contents of an already-existing SHM as required for a read snapshot,
but it may not create a sidecar. The adapter never deletes, checkpoints,
truncates, or separately parses sidecars.

After open, the adapter sets `PRAGMA query_only=ON` and a short busy timeout,
then verifies `PRAGMA query_only` is `1`. Each request begins a read transaction
before the first schema or data query and commits only after all requested rows
have been materialized, producing one coherent snapshot while a writer remains
active. A busy snapshot returns `read_busy`; it never falls back to the stale
main database, a backup, or a copied file. The connection is closed in
`finally` and no migration, checkpoint, attach, vacuum, or write statement is
present in the query catalog. Immediately after open and again before returning,
the worker rechecks the canonical main path and the existence, canonical path,
type, identity, and size of every sidecar against its pre-open snapshot. A
creation, replacement, reparse, or bound violation fails the request, which
closes the pre-open race without returning queried data.

All SQLite work runs in a new disposable `worker_threads` worker, never on the
Gateway event loop. The parent accepts only a fixed action/period message,
starts a 3-second deadline, and terminates the worker on timeout, abnormal exit,
or protocol violation. Timeout is reported as `read_timeout`; worker exception
messages and stacks never cross the boundary. The usage worker first uses the
required `idx_request_logs_created_at` index (validated by `PRAGMA index_info`)
to count the selected maximum 30-day interval and refuses more than 250,000
detail rows or 100,000 rollup rows as `resource_limit`. Fixed SQL includes the
same bounded date predicates. Tests prove a terminated long query does not
delay an independent Gateway timer or message handler.

The adapter validates required tables and columns through `sqlite_master` and
`PRAGMA table_info`. It records `PRAGMA user_version` for diagnostics, but does
not accept a schema merely because the version number is known. Each action
declares its own minimum tables and columns, so a missing health table does not
prevent a basic overview if the overview's dependencies remain valid.

`PRAGMA user_version` is labeled `database_schema_version`; it is never shown
as the CC Switch application version. V1 has no trusted, cross-installation
source for the desktop version, so `application_version` is reported as
`unavailable`. The known development-machine version in this document is
context only and is not emitted at runtime.

The reader does not inspect backup databases, logs, WebView storage, or account
files as fallbacks. Schema mismatch returns `schema_incompatible`; missing
data returns `not_installed` or `data_unavailable`; lock and query failures
return a bounded `read_failed` category.

## Safe Provider Projection

Provider rows expose only these non-secret scalar database columns after type
and length validation: `app_type`, `name`, `is_current`, `category`,
`provider_type`, and `sort_index`. Internal provider IDs and the complete
provider record are never projected.

`settings_config` is treated as secret-bearing input. V1 parses it only when
`app_type` is exactly `claude`, the value is valid JSON, and the encoded JSON is
at most 256 KiB. It reads one string scalar at the exact path
`$.env.ANTHROPIC_BASE_URL`. Configured model values are not projected in V1;
models in usage output come only from stored usage dimensions.

No recursive walk, fuzzy key match, alternate casing, array traversal, or
object serialization is allowed. For Codex and every other app, safe
connection metadata is `unavailable` in V1; in particular, Codex TOML is not
parsed until a structured TOML dependency and a separately reviewed exact-path
allowlist exist.

The adapter never serializes the parsed object and never uses substring
redaction on a raw blob. Values from keys containing `key`, `token`, `secret`,
`password`, `credential`, `auth`, `cookie`, or `session` are excluded even if a
future schema places them under an otherwise allowlisted object. Codex TOML is
not parsed with regular expressions; without an existing structured TOML
parser it is reported as unavailable rather than risking adjacent credential
disclosure.

The base URL parser accepts only absolute `http:` or `https:` URLs with empty
username and password. It returns only the normalized origin
`scheme://hostname[:non-default-port]`; path, query, and fragment are discarded
before formatting. Invalid URLs and URLs with user info are `unavailable`, so
credentials embedded in a URL path or query can never be displayed. Origins
are bounded to 300 characters.

Every database-derived display label, including provider names, app types, and
usage model names, passes a common public-label projector. It first applies
Unicode NFKC normalization, removes controls, and uses ASCII case-insensitive
matching to reject credential markers (`bearer`, `token`, `secret`, `password`,
`credential`, `cookie`, `session`, `sk-`) or any 24-character run of ASCII
letters, digits, `_`, `-`, `=`, or `+`. It then requires 1-100 Unicode
letters/numbers or the punctuation ` ._:/()@+-`. A rejected label becomes
`不可显示` and the raw value is never logged. Hostnames are NFKC-normalized and
rejected by the same case-insensitive credential-marker and long-run checks
before their origin is emitted.

## Usage Semantics

All public periods use Asia/Shanghai calendar boundaries:

- `today`: today's 00:00 through now;
- `yesterday`: the previous calendar day;
- `last_7_days`: today plus the previous six calendar days;
- `last_30_days`: today plus the previous 29 calendar days.

The reader computes explicit epoch-second start/end parameters in Node and
passes them to fixed SQL. It does not interpolate dates into SQL.

### Usage Schema Domain

The detail query requires `proxy_request_logs` with these declared/runtime
contracts and selects no other columns:

- `request_id`: primary-key `TEXT`, runtime non-empty string up to 200 bytes;
- `provider_id`, `app_type`, `model`: declared non-null `TEXT`, runtime strings
  up to 200, 32, and 200 bytes respectively; only `app_type` and `model` enter
  the public-label projector;
- `input_tokens`, `output_tokens`, `cache_read_tokens`,
  `cache_creation_tokens`, `input_token_semantics`, `latency_ms`,
  `status_code`, and `created_at`: declared non-null `INTEGER` with runtime
  SQLite `integer` storage; `created_at` is a positive Unix epoch second that
  must convert to a finite instant no more than five minutes in the future, and
  `status_code` must be from 100 through 599;
- `total_cost_usd`: declared non-null `TEXT` with runtime SQLite `text` storage
  and the decimal grammar defined below.

The rollup query requires `usage_daily_rollups` with the declared composite
primary key `(date, app_type, provider_id, model, request_model,
pricing_model)`. All required columns are declared non-null. `date`,
`app_type`, `provider_id`, `model`, `request_model`, `pricing_model`, and
`total_cost_usd` must have declared type/runtime storage `TEXT`/`text`;
`request_count`, `success_count`, all four token columns,
`avg_latency_ms`, and `input_token_semantics` must have declared type/runtime
storage `INTEGER`/`integer`. `date` is exactly `YYYY-MM-DD` and must round-trip
as a valid Asia/Shanghai calendar date. Internal IDs and request/pricing model
dimensions are validated and used for canonical identity only; they are not
formatted. All internal identity strings are bounded to 200 bytes.

A missing table/column, wrong declared type, wrong primary-key order, or
declared-nullability mismatch returns `schema_incompatible`. A row-level
storage/type/range violation returns `data_invalid`.

`proxy_request_logs` contains recent detailed rows and is pruned by CC Switch's
retention job. `usage_daily_rollups` contains daily aggregates, but schema
version 18 exposes no authoritative retention or rollup-finalization watermark.
V1 therefore reports observed stored usage and never claims that a requested
period is complete.

The canonical detail identity is the `proxy_request_logs.request_id` primary
key. The canonical rollup identity is the full `usage_daily_rollups` primary
key: `(date, app_type, provider_id, model, request_model, pricing_model)`.
Queries select directly from each source and aggregate before provider-name
lookup, so joins cannot duplicate facts. Duplicate canonical identities or an
invalid date fail the usage action as `data_invalid` rather than being guessed.

Source selection is deterministic at the Asia/Shanghai calendar-day level:

1. If a requested day has one or more detail rows, use only its observed detail
   rows and ignore all rollups for that day.
2. Otherwise, for an already-ended day with one or more rollup rows, use only
   those rollups.
3. Never use a rollup for the current, still-open day.
4. A day with neither source contributes no fabricated zero rows.

This date-level precedence makes the sources disjoint, including when retention
starts partway through a day. Every result has coverage `observed_only` and
includes per-day source labels (`detail`, `rollup`, or `none`). Mixed sources,
a leading/trailing `none`, or use of detail on an already-ended day adds a fixed
`potentially_incomplete` warning. Zero rows are described as `未观察到用量数据`,
not as proof that no requests occurred.

Totals include:

- request count and success count;
- input tokens partitioned by `input_token_semantics`, plus output tokens;
- cache-read and cache-creation tokens;
- total estimated USD cost;
- average latency when available.

Success follows CC Switch's stored status semantics and counts HTTP status
codes from 200 through 399 for detail rows; rollups use their stored success
count. Integer counts and tokens must be safe non-negative integers, and every
rollup must satisfy `0 <= success_count <= request_count`; otherwise the action
returns `data_invalid`.
`input_token_semantics` must be an integer from the schema-v18 domain `0`, `1`,
or `2`. Input tokens are aggregated and displayed separately for each observed
semantic value across both sources. They are never combined with one another
or with cache tokens, and V1 does not assign undocumented names to the numeric
semantic values. Output and cache token columns retain the same schema-v18
meaning across both sources and may be combined.

Detail latency contributes `latency_ms` as its numerator and one request as its
denominator. A rollup contributes `avg_latency_ms * request_count` and
`request_count`. The mixed weighted average is numerator divided by denominator,
rounded half-up to the nearest millisecond; it is labeled `estimated` whenever
a rollup is present because the stored daily average may already be rounded.
Latency and request-count inputs must be safe non-negative integers. Numerator
and denominator accumulation and multiplication use `BigInt`; half-up rounding
is integer division of `(2 * numerator + denominator) / (2 * denominator)`.
The formatted result must fit a JavaScript safe integer. Zero-request rollups,
negative/null latency, or a final overflow are `data_invalid`.

Cost columns are selected as SQLite TEXT and are never cast through SQL REAL or
JavaScript Number. The worker accepts only canonical non-negative decimal text
matching `^(0|[1-9][0-9]*)(\.[0-9]{1,12})?$`, converts it directly to integer micro-USD,
rounds half-up from the seventh fractional digit, sums with `BigInt`, and
formats exactly six decimal USD places. Integer counts and tokens must be safe
non-negative integers; overflow, malformed decimals, or unexpected semantic
values return `data_invalid`.

Breakdowns are computed by app, provider, and model. Provider display names
are joined by `(provider_id, app_type)`; deleted or missing providers are shown
as `未知 Provider`, never as an internal ID. Results sort by total tokens then
request count, then projected label by Unicode code-point order. Where input
semantics differ, the total-token sort key excludes input tokens and uses
`output + cache-read + cache-creation`; the output labels this fact. Each
dimension then uses its raw app type, provider composite key, or raw model value
as a non-displayed final tie-breaker. Each dimension shows at most ten rows and
reports how many were omitted. A duplicate provider lookup key is
`data_invalid`, never an arbitrary name choice.

## Output Contracts

Every response uses the global gateway header and a short action-specific
title. The skill body is limited to 12,288 UTF-8 bytes. The formatter builds
complete records in deterministic order and appends a record only when it and a
fixed final omission marker fit. It never slices a JavaScript string, Unicode
code point, or record. The global header is outside this body limit.

`overview` shows:

- installation state, `application_version: unavailable`, and database schema
  version;
- database last-write time, latest detail usage time, and latest rollup date;
- one current-provider line per app;
- one routing-state line per app.

### Overview Schema Domain

`overview` requires the full Provider/Current-Provider and Routing Status
schemas defined below. It forms the union of raw `app_type` values from those
two sources; an app missing one side shows that side as `unavailable`. It sorts
the union by projected app label, then raw app type as a non-displayed stable
key, and applies the 16-row cap after the union.

Usage freshness is optional and never changes overview provider/routing
availability. If `proxy_request_logs` exists with the exact declared
`created_at INTEGER NOT NULL` column, overview selects only `MAX(created_at)`
and validates it as a positive epoch second no more than five minutes in the
future. If `usage_daily_rollups` exists with exact declared `date TEXT NOT NULL`,
it selects only `MAX(date)` and validates strict `YYYY-MM-DD` as above. A
missing optional table is displayed as `unavailable`; a present but incompatible
or invalid freshness source is displayed as `schema_incompatible` or
`data_invalid` for that field without failing the provider/routing summary.
Detail time and rollup date remain separate and are never coerced into one
possibly misleading timestamp.

`providers` shows at most 50 providers, grouped by projected app label then raw
app type. Inside each group the current entry is first; remaining ties sort by
non-null `sort_index` ascending with null last, then projected provider name,
then internal provider ID as a stable final key that is never displayed.
`health` shows at
most 50 providers, sorting unhealthy, unknown, then healthy, with stale first
inside each state, then projected name, raw app type, and internal provider ID
as non-displayed final keys. `routing_status` shows at most 16 app rows sorted
by projected app label then raw app type. `overview` uses the union and order
defined above and shows at most 16 app rows. `usage` shows the period, coverage
indicator, totals, then at most ten rows in each app/provider/model section.
Every cap reports an exact omitted-row count.

Zero rows are a successful `未观察到用量数据`, not an error. All expected failures
use fixed Chinese messages and stable internal categories. Raw SQLite errors,
SQL text, local paths, configuration blobs, and provider errors remain in
neither output nor diagnostics.

Diagnostics use a closed structured schema only: event name, CC Switch action,
stable outcome category, database schema version when validated, elapsed-time
bucket, and row-count bucket. They never include exception messages, SQLite
messages, SQL text, paths, row values, provider/model names, URLs, or message
content. The public result is formatted before outbox persistence; neither raw
rows nor a diagnostic object is placed in the outbox.

## Routing Status Domain

`routing_status` reads exactly one `proxy_config` row per `app_type` and only
these columns:

- `app_type`: validated bounded string used for grouping;
- `enabled`, `proxy_enabled`, `enable_logging`, `auto_failover_enabled`, and
  `live_takeover_active`: SQLite integers exactly `0` or `1`, normalized to
  booleans;
- `listen_address`: string normalized to `loopback` for `localhost`,
  `127.0.0.1`, or `::1`, otherwise `non_loopback`; the raw address is not
  emitted;
- `listen_port`: integer from 1 through 65535;
- `updated_at`: SQLite `text` in CC Switch's exact UTC format
  `YYYY-MM-DD HH:mm:ss`; it must round-trip as a valid instant no more than five
  minutes in the future and is emitted as RFC 3339 normalized to UTC.

`enabled` is labeled as the row's master enabled state and `proxy_enabled` as
the local proxy state; V1 does not infer one from the other. Failover output is
only the boolean `auto_failover_enabled`; queue IDs, provider order, attempt
counts, and failover configuration are never queried. Missing rows produce an
empty result, while duplicate app rows, conflicting values, wrong scalar types,
or invalid ports/timestamps return `data_invalid` for this action. The table
must declare `updated_at TEXT NOT NULL`; a declared schema mismatch is
`schema_incompatible`.

## Provider and Current-Provider Domain

Provider identity is the validated composite primary key `(id, app_type)`;
`id` is used only for internal equality joins and is never formatted. Provider
queries select `id`, `app_type`, `name`, `is_current`, `category`,
`provider_type`, `sort_index`, and, only for the `providers` action,
`settings_config`. `is_current` must be integer `0` or `1`; `sort_index` must be
null or a safe integer; nullable category/type values must be bounded scalar
strings before public-label projection. Duplicate keys are `data_invalid` even
if the table declaration is malformed or a test fixture bypasses constraints.

For each app with at least one provider, exactly one `is_current=1` row is the
current provider. Zero current rows produce the fixed state `未设置当前
Provider`; more than one current row for an app is `data_invalid` for
`overview` and `providers`. Apps with no provider rows are simply absent. The
same current-provider reducer is shared by both actions.

## Health Domain

`health` selects exactly `provider_id`, `app_type`, `is_healthy`,
`consecutive_failures`, `last_success_at`, `last_failure_at`, and `updated_at`
from `provider_health`. It deliberately does not select `last_error`. The table
must declare the composite primary key `(provider_id, app_type)`, which joins
one-to-one to `providers.(id, app_type)`. Duplicate health keys, duplicate
provider lookup keys, or orphan health keys are `data_invalid`; joins cannot
multiply output rows.

`is_healthy` must be integer `0` or `1` and becomes `unhealthy` or `healthy`.
`consecutive_failures` must be a safe non-negative integer. The success and
failure timestamps may be null; all non-null health timestamps must be bounded
RFC 3339 strings with an explicit `Z` or numeric offset, parse to a finite
instant, and are emitted normalized to UTC. `updated_at` is required and uses
the same validation. A provider without a health row is shown as `unknown` with
no counters or timestamps. A present row older than 24 hours is labeled
`stale` while preserving its stored healthy/unhealthy value; freshness is never
silently treated as health. Future timestamps more than five minutes ahead are
`data_invalid`.

## Components

- `schemas/intent.schema.json`: add `ccswitch`, `ccswitch_action`, and
  `usage_period` enums.
- `prompts/route.md`: add pure CC Switch query routing and read-only mutation
  rejection rules.
- `src/resolver.mjs`: enforce the exact per-subcommand field contract.
- `src/internal-skills.mjs`: register the single `ccswitch` namespace.
- `src/ccswitch-reader.mjs`: asynchronous parent facade, fixed worker protocol,
  deadline/termination, and public error mapping.
- `src/ccswitch-worker.mjs`: fixed-path validation, per-action schema checks,
  read-only SQLite queries, safe projection, and period aggregation inside a
  disposable worker thread.
- `src/ccswitch-skill.mjs`: subcommand dispatch and bounded formatting.
- `src/gateway.mjs`: inject the reader/handler and dispatch only structured
  arguments.
- `test/ccswitch-reader.test.mjs`: database, schema, projection, period, and
  aggregation tests.
- `test/ccswitch-skill.test.mjs`: routing, formatting, caps, and public-error
  tests.
- `test/gateway.test.mjs`: registry/resolver isolation and proof that internal
  queries create no project session or task.
- `README.md`: document supported phrases, data source, and read-only scope.

## Security

- The sender allowlist and static internal-skill registry remain mandatory.
- Messages select only fixed enums; they cannot supply SQL, paths, provider
  IDs, URLs, ports, or display strings.
- The database connection is read-only and query-only.
- Secret-bearing configuration is never returned, logged, or stored in the
  gateway database or outbox beyond the safe formatted response.
- The skill performs no network requests. It reports stored usage and health;
  it does not contact providers to refresh balances or validate credentials.
- Database-derived strings are length-bounded and single-line sanitized before
  entering Feishu output or logs.
- No query returns request content, response content, session identifiers, or
  raw error messages.
- Read failures never fall back to backups, WebView data, or tool config files.
- Future mutation support requires a separate reviewed design and cannot be
  enabled by adding a router synonym alone.

## Testing and Verification

Automated tests use temporary SQLite fixtures and cover:

- all five actions and all four usage periods;
- default-to-today routing and Chinese period synonyms;
- mixed project/internal requests, invented actions, arbitrary arguments,
  mutation requests, and prompt-injection-shaped input;
- fixed-path, canonical-path, symlink/reparse, size, read-only, query-only, and
  busy-database behavior;
- live WAL visibility with an active writer, coherent snapshots across multiple
  queries, valid sidecars, malformed/reparse sidecar rejection, and proof that
  a busy read never falls back to a stale copied or main-file-only view;
- per-action missing-table and missing-column compatibility failures;
- current provider ordering, missing provider joins, health projection, and
  routing projection;
- absence of API keys, tokens, auth values, raw config, raw errors, internal
  IDs, session IDs, and control characters in every output;
- Asia/Shanghai day boundaries, leap/daylight-independent calendar math,
  epoch seconds, zero rows, and exact end-exclusive intervals;
- detailed-only, rollup-only, disjoint date-level mixed coverage, canonical-key
  deduplication, same-day overlap precedence, missing-day/partial-boundary
  incompleteness, and deleted-provider aggregation;
- mixed-source fixtures with different input-token semantics and request counts,
  semantic-separated input totals, decimal-text cost rounding, weighted latency,
  and null/overflow rejection;
- zero/multiple current providers, missing/stale/orphan/duplicate health rows,
  invalid booleans/timestamps, and proof that `last_error` is never selected;
- success rate, cache columns, complete stable sort keys, exact per-action caps,
  omitted counts, and record-safe 12,288-byte UTF-8 output limiting;
- internal dispatch creates no gateway project session, task, approval, or
  coding-agent worker process; only the bounded disposable SQLite reader worker
  is created.
- secret canaries placed in JSON keys, URL user info/path/query, model values,
  provider/display names, hostnames, provider errors, SQLite errors, and incoming
  messages are absent from public output, structured logs, thrown errors, and
  persisted outbox rows.

Verification runs focused tests, the full Node suite, `git diff --check`, and
syntax checks. A production read-only smoke test compares today's request,
success, output/cache-token, per-input-semantics, and cost aggregates with a
separate fixed query without printing sensitive rows.
After a safe gateway restart, Feishu end-to-end checks invoke each query and
confirm no project session/task is created. No provider is switched and no
routing state is changed during testing.

## Rollout and Recovery

The implementation requires no gateway database migration and makes no logical
CC Switch database mutation: it issues no DML/DDL, migration, checkpoint, or
journal-mode change. SQLite may lock and update an already-existing SHM mapping
while taking a WAL read snapshot, as described above, but the skill never
creates auxiliary files and fails closed when safe read-only participation is
not possible. Rollout order is schema/prompt/resolver, worker/reader,
formatter/registry, tests, documentation, gateway restart, and read-only Feishu
smoke tests.

If a CC Switch upgrade changes the schema, only affected subcommands return
`schema_incompatible`; the gateway and unrelated internal skills continue to
operate. Removing the `ccswitch` registry/schema entries and handler wiring
fully disables the capability. Because the feature never writes CC Switch
state, rollback requires no data repair.
