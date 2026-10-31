# Shared discovery API

SessionMgr owns project/session overview, working-session observation and native historical discovery. Gateway's old source paths are compatibility exports; this package never imports Gateway source, configuration or databases. These modules are ordinary JavaScript APIs, not a prompt to another agent.

| Entry | Responsibility |
| --- | --- |
| `scripts/claude-reader.mjs` | Shared Claude list reader, metadata-only mode, registry observations and exact transcript envelope check; no deletion writes |
| `scripts/session-list.mjs` | `collectSessionList` reads all projects via existing list adapters; `formatSessionListPages` emits every session in byte-bounded pages |
| `scripts/off-work.mjs` | `inspectOffWork` previews recognized Windows clients; `executeOffWork` is the explicitly authorized close-and-verify action, separate from read-only queries |
| `scripts/queries.mjs` | `inspectManagedWorkspace(options)` and `listWorkingSessions(options)`; JSON results using existing harness/current/all scope rules |
| `scripts/discovery/agent-workspace-overview.mjs` | Structured `collectWorkspaceSnapshot` and existing Chinese Gateway overview formatter |
| `scripts/discovery/active-agent-sessions.mjs` | Working-session aggregation, bounded native collection, exact observation and display; optional Gateway snapshots supplied by caller |
| `scripts/discovery/claude-session-history.mjs` | `collectClaudeHistory`, project-scoped history, bounded Worker and exact ID/cwd revalidation |
| `scripts/discovery/session-catalog.mjs` | Merge native/Gateway identities, verified project policy, lookup and resume guards |

The CLI lazily imports `queries.mjs` for `overview`/`active`. The optional discovery path supports Windows and Node 24+; the existing native Codex list/delete adapter keeps its app-server contract. Codex discovery uses the existing bounded SQLite/index collector. Gateway provides its read-only Store interface and activity snapshots; no standalone query implicitly attaches to a running Gateway.

Codex overview enumerates state user threads, including archived and unnamed ones absent from the optional name index. Internal guardian/subagent rows are excluded; legacy null thread_source rows require a known user source. Missing source columns or limits report incomplete. Current-scope project totals include only the requested canonical project, even when session display evidence contains historical cwd paths. This display filtering does not grant resume authority.

Claude `list` and remote discovery use the same `listSessions` implementation. Discovery passes `metadataOnly: true, includeEvidence: true`: explicit titles, runtime names, IDs, cwd and timestamps are retained, prompt/summary-derived names are suppressed, and no message bodies enter the public discovery records. `list` preserves its existing title fallbacks and deletion planning behavior. Runtime registrations are read through `readClaudeRegistry`; a live idle owner still blocks competing resume even though `active` excludes idle work.

History discovery runs in a disposable Worker with a 15-second deadline and 192 MB V8 old-generation limit. It limits project directories to 2048 and entries to 20000. Timeout, read failure or scan limit yields incomplete data, never an authoritative no-match. Gateway's existing active-collection limits and exact stop ownership checks remain. Inspection is read-only; the shared Windows helper retains Gateway's existing explicit termination operation for its separately authorized stop path, which query APIs never invoke.

Only one native transcript with a matching ID and verified original cwd envelope can supply resume authority. Later cwd observations remain display evidence; duplicate native transcripts cannot grant authority. Index/history/runtime-only records remain visible without authority. Excluded projects are filtered; linked paths, conflicting ownership and missing evidence cannot authorize execution. ID/cwd are revalidated before resume. Queries never execute deletion, new-session creation, resume or stop actions themselves.

Native `observedProjects` and overview `displayProjects` preserve displayable path evidence separately from verified `projectPath`/authority. Overview groups include observed paths, even for unavailable projects. A multi-project record contributes to each associated project, so per-project counts can overlap; unknown means no path evidence. Neither display field may authorize resume or project creation.

Gateway's `list_agent_sessions` uses `collectSessionList`, not overview totals or Gateway's recent-session limit. Remote unscoped list queries mean all local projects; the CLI retains its default current-project scope. Full lists retain normal name fallbacks (summary/first input), mark derived names, show full IDs and every recorded path, and report owner state separately from active work or resumability. All pages are persisted together before delivery; retry of the same inbound message keeps the original snapshot. Exact pure list phrases route deterministically; mixed work and notification replies retain their existing routing rules.

Consumers must preserve completeness, scope, executor identity and unknown activity. CLI Session lists use recent activity descending, then harness and full ID. Gateway retains its internal names `inspect_agent_workspace` and `list_active_agent_sessions`, stop-reference decoration, Feishu routing and scheduling.

Catalog eligibility reads native Codex `archived` state and probes every candidate's writer lock in batches. Archived records and Gateway mappings whose native history is missing remain visible but unavailable; incomplete snapshots never prove absence. Resume rechecks archive/native identity and writer ownership. Claude revalidation repeats the complete global source-uniqueness check and checks the original native envelope, not later working-directory observations. Remote list messages have both a 25-record limit and a UTF-8 byte limit; no records are silently omitted.

Install the whole `skills/session-mgr` directory alongside `claude-projects/lark`; workers/probes use module-relative paths. Run `node --test tests/*.test.mjs` from SessionMgr and `npm test` from Gateway. Fixtures cover shared title sources, privacy, project evidence, worker timeout, ownership/work distinctions, scope and compatibility exports. No live session deletion is required for migration verification.
