# Lark Gateway Task-Scoped Approval Grants

## Goal

Reduce repeated Feishu approval round trips without granting permanent or process-wide PowerShell access. Authorization must remain bound to one Gateway task, one session, and one verified project root.

## User Interface

Approval prompts offer three actions:

- `批准 RQ-...`: approve only the referenced request.
- `批准同类`: approve the replied request and later requests in the same task with the same safe command class.
- `全部批准`: approve all current and later grant-eligible requests in the replied task.

All approval controls use a deterministic parser over the exact raw typed message. The accepted grammar is exactly `批准 RQ-...`, `拒绝 RQ-...`, `批准同类`, or `全部批准`, allowing only surrounding whitespace and normalized character width. Extra clauses, negation, questions, quotations, LLM-derived intent, and voice transcripts cannot approve or grant anything.

A reply is required for `批准同类` and `全部批准`. Each approval prompt persists an immutable binding from the outbound Feishu message ID to the exact task ID, session ID, approval IDs, batch generation, and command class. A reply is accepted only while that exact batch is current and the task is actively owned. An unbound message must not infer a target from recent activity.

Parallel requests from the same task and same command class are collected into one bounded summary message when possible. Mixed classes use separate prompts, so `批准同类` always has one unambiguous class. A newer batch supersedes its earlier prompt; replies to stale or superseded batches are rejected. Granting a task or class grant resolves every currently waiting eligible request atomically and applies to eligible requests created later in that task.

## Grant Scope And Lifetime

A grant contains the task ID, session ID, canonical project root, mode (`class` or `task`), optional command class, creation time, and expiry. It is never shared across tasks or sessions.

The grant expires when the task completes, fails, is cancelled, is interrupted, or reaches the worker/task timeout. A per-request approval timeout rejects only that waiter; it does not release task ownership or terminalize the task, though policy may conservatively revoke its task grants. Gateway restart unconditionally expires every grant. This version does not restore grants from persisted state.

The scheduler owns grant state because it owns the running task and approval waiters. The executor submits structured approval evidence to the scheduler and receives `approve` or `reject`; it does not decide task grants itself.

## Eligible Operations

`全部批准` means all operations in a closed operation-class registry whose validator returns `grantEligible: true` for the exact structured request. Project locality and protected-path checks are necessary but not sufficient. It is not equivalent to trusting `powershell.exe`.

The initial registry contains only `svn-status`, `svn-revert`, and existing project-local non-delete file changes. Each class has its own strict validator. Network publication and remote mutation such as `git push`, package publishing, deployment, upload, or API mutation are not grant-eligible even when launched from the project directory. Unknown classes always require individual approval or rejection.

The following remain ineligible for task or class grants and require an individual explicit approval, or are rejected when the existing policy requires rejection:

- paths outside the canonical project root;
- Gateway policy, analyzer, profile, credential, token, SSH, cloud configuration, or other protected files;
- process termination, service/task-scheduler changes, privilege changes, registry changes, network credential operations, or shell/profile mutation;
- commands whose executable, arguments, cwd, target paths, or shell structure cannot be parsed and validated;
- compound commands, pipelines, redirection, dynamic evaluation, variable-derived targets, or nested shell execution unless an existing strict classifier proves the complete operation safe.

Existing automatic read and project-local non-delete file-change approval remains unchanged.

## Explicit Intent Grants

The original typed task text may create a narrow grant only for a closed, deterministic intent recognizer. The first supported intent is SVN working-copy restoration.

Only these normalized imperative forms create an automatic `svn-revert` grant, allowing optional whitespace and case variation but no additional clauses:

- `还原svn所有修改`
- `恢复svn所有修改`
- `svn还原所有修改`
- `svn恢复所有修改`
- `revert all svn changes`

The deterministic standard-command parser extracts the exact typed content slice after the executor and Session name and tags its provenance. The grant profile is decided and persisted when the task is created; executor content is never reparsed to create authority. LLM-routed content, voice transcripts, reply-inherited free text, and any content without deterministic typed-input provenance cannot create an automatic destructive grant.

Any negation, question form, quotation, example, conditional wording, explanatory wording, extra clause, or partial target creates no grant. Examples that must not match include `不要还原svn所有修改`, `如何还原svn所有修改？`, `如果要还原svn所有修改`, `示例：还原svn所有修改`, and `还原svn的部分修改`.

An accepted restoration intent creates one authorization profile containing two separate grants: `svn-status` and `svn-revert`. Replying `批准同类` to a status request grants only `svn-status` and can never grant `svn-revert`.

The classes accept only:

- `svn status` in the verified project cwd for `svn-status`;
- `svn revert --depth infinity <target>` where `<target>` resolves to the project root or a descendant;
- a canonical full path equal to the configured trusted `svn.exe`; a bare `svn` is accepted only after runtime command resolution proves it resolves to that same canonical file;
- one command with no pipeline, redirection, command separator, URL, revision target, alternate config directory, or dynamic expression.

Before automatically accepting recursive revert, Gateway first rejects any recursive target that is an ancestor of any protected path, regardless of current SVN status. It then obtains the complete modified/versioned affected path set through the trusted SVN executable's machine-readable status output. Every affected path is canonicalized using the existing-ancestor rule and checked against the project root and protected-path policy. Missing, malformed, truncated, conflicting, unversioned, or inaccessible status evidence fails closed. This prevents a clean protected descendant from entering the revert between status preflight and execution.

This grant covers separately discovered SVN working copies below the project root only after applying the same affected-path validation to each target. Any other command still follows normal approval rules. If no configured trusted SVN executable exists, no SVN command is automatically grant-eligible.

## Command Classification

Approval requests are normalized into structured evidence before matching a grant: kind, canonical executable, canonical cwd, operation class, and canonical target paths. Display text is never used as the security decision input.

For Codex command approvals, the classifier consumes the structured RPC command payload and validates the exact PowerShell wrapper plus inner command. A bare PowerShell executable is never itself a safe class. File-change approvals use the existing canonical path and protected-file checks.

Unknown, malformed, incomplete, or conflicting evidence fails closed and creates a normal individual approval.

## Persistence And Concurrency

Approval rows retain their individual IDs. A grant operation transitions only pending rows belonging to the exact task and only after revalidating every row against the requested grant. Ineligible rows remain pending and are reported separately.

The scheduler serializes approval registration and grant installation per task. Request processing performs `grant check -> persist row -> register waiter -> post-registration grant recheck` inside that protocol, and the waiter is registered before its prompt is exposed through the outbox. Grant installation happens before matching waiters are resolved. This closes the race where a request checks just before grant installation and registers afterward.

Resolution is idempotent: repeated Feishu messages cannot resolve an approval twice or widen a grant. One terminal cleanup path, used for completion, failure, cancellation, interruption, worker/task timeout, and shutdown, rejects all remaining waiters, marks their pending approval rows terminal, removes grants and prompt bindings, and then releases task ownership. Per-request approval expiry rejects and terminalizes only that approval waiter and does not release task ownership. Reply handling additionally verifies that the task is still active and owned by this Gateway instance.

## Messaging

The first manual prompt states all available replies and the task boundary. A successful task grant reply reports how many current requests were approved and that later eligible requests in the same task will be accepted automatically. If protected or unclassifiable requests remain, the response lists their request IDs without sensitive command output.

## Testing

Tests must cover:

- explicit SVN restore intent accepts all valid root and descendant `status`/`revert` requests without a Feishu round trip;
- only provenance-tagged content from the deterministic typed command parser can create the SVN grant profile; LLM-routed, voice-derived, and inherited content cannot;
- approval and grant replies accept only exact raw typed grammar; negated, extended, LLM-routed, and voice-derived variants cannot authorize anything;
- similar wording that does not clearly authorize reversion creates no grant;
- negated, quoted, hypothetical, explanatory, question, extra-clause, and partial-target SVN wording creates no grant;
- `批准同类` applies only to the replied request's class and exact task;
- approving the `svn-status` class never authorizes `svn-revert`;
- `全部批准` handles current and future eligible requests in one task but not another task in the same session;
- non-allowlisted project-local operations such as `git push`, package publication, deployment, and uploads remain individually approved;
- project escapes, protected files, compound shell syntax, unknown commands, and process/system operations are never covered by a grant;
- recursive reverts fail closed unless every affected versioned path is completely enumerated and validated;
- a recursive target containing any protected descendant is never grant-eligible, even when that descendant is currently clean;
- bare `svn` must resolve to the configured canonical executable, and a shadow executable is rejected;
- task completion, failure, cancellation, interruption, worker timeout, and restart clear or fail closed on grants, while one approval expiry affects only its waiter;
- concurrent request creation and repeated grant messages are atomic and idempotent;
- a request racing with grant installation is either covered after the post-registration recheck or remains a valid waiter, never stranded;
- restart unconditionally expires grants, prompts, pending rows, and waiters;
- approval prompts are bounded and parallel pending requests are summarized without leaking raw output;
- all existing single-request approval behavior remains compatible.
