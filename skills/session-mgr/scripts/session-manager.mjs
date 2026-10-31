#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fail, matchSessions } from './session-store.mjs';
import { executeManagedDelete, listManagedSessions, previewManagedDelete } from './harnesses.mjs';

const help = `SessionMgr - local agent harness Session manager (Node.js 18+)
  --harness claude|codex|all|auto                 Default: current caller; ambiguous callers must select
  list [--query NAME_OR_ID]
  overview [--query NAME_OR_ID]                  Project/session metadata and resume capability (Windows, Node 24+)
  active [--query NAME_OR_ID]                    Working sessions; excludes idle owners (Windows, Node 24+)
  off-work                                     Preview all recognized Agent CLI/Desktop processes (Windows)
  off-work --execute                           Close clients in an independent worker; keeps history and Gateway
  delete --query NAME_OR_ID                     Resolve and preview only
  delete --id FULL_UUID                         Preview exact target
  delete --id FULL_UUID --expect HASH --execute [--allow-active | --allow-unknown]
  delete --current-session auto                 Resolve and verify the current harness Session
  delete --current-session FULL_UUID            Preview only if this UUID is still current
  delete --current-session FULL_UUID --expect CONFIRMATION_HASH --execute --allow-active

History/query operations accept --scope current|all (default: current), --project DIR, --root DIR.
off-work instead covers all recognized clients of the current Windows user; only --execute is accepted.
Current project defaults to the caller's working directory. --project pins it explicitly.
Use --scope all to operate across projects; it cannot be combined with --project.
All output is JSON. Fuzzy matches always require selection, even one candidate.
Every Session list and candidate list is sorted by lastActiveAt, newest first.
Execute only after a user deletion request; active/unknown overrides require user confirmation.
Codex uses native thread/delete; --allow-descendants requires confirmation of every listed child.
Codex accepts --codex-bin FILE and --server-socket PATH (existing local app-server proxy).
--current-session verifies fresh shell context with the selected harness runtime.
Missing or conflicting runtime identity blocks self deletion; cached skill UUIDs are not trusted.
It always requires active confirmation. Never set the runtime variables manually.
Only off-work terminates processes; deletion commands do not. No cloud deletion is performed.
`;

try {
  const { values, positionals } = parseArgs({ options: {
    root: { type: 'string' }, query: { type: 'string' }, id: { type: 'string' }, expect: { type: 'string' },
    scope: { type: 'string' }, project: { type: 'string' },
    harness: { type: 'string' }, 'codex-bin': { type: 'string' }, 'server-socket': { type: 'string' },
    'current-session': { type: 'string' },
    execute: { type: 'boolean' }, 'allow-active': { type: 'boolean' }, 'allow-unknown': { type: 'boolean' },
    'allow-descendants': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  }, allowPositionals: true, strict: true });
  if (values.help || !positionals.length) {
    console.log(help);
    if (!values.help) process.exitCode = 1;
  } else {
    const [command] = positionals;
    if (positionals.length !== 1 || !['list', 'overview', 'active', 'delete', 'off-work'].includes(command)) throw fail('invalid_command', help);
    const options = { root: values.root, query: values.query, id: values.id, expect: values.expect,
      scope: values.scope, project: values.project,
      harness: values.harness, codexBin: values['codex-bin'], serverSocket: values['server-socket'], allowDescendants: values['allow-descendants'],
      currentSessionId: values['current-session'],
      allowActive: values['allow-active'], allowUnknown: values['allow-unknown'] };
    let result;
    if (command === 'off-work') {
      if (Object.keys(values).some(name => name !== 'execute')) throw fail('invalid_options', 'off-work is current-user, all-client scope; only --execute is accepted');
      if (values.execute) {
        const { startOffWorkJob } = await import('./off-work-jobs.mjs');
        result = await startOffWorkJob();
      } else {
        const { inspectOffWork } = await import('./off-work.mjs');
        result = await inspectOffWork({ detachedWorker: true });
      }
    } else if (command !== 'delete') {
      if (values.id || values.execute || values.expect || options.currentSessionId !== undefined || options.allowActive || options.allowUnknown || options.allowDescendants) throw fail('invalid_options', 'Deletion flags are not valid for list');
      if (command === 'list') result = await listManagedSessions(options);
      else {
        const { inspectManagedWorkspace, listWorkingSessions } = await import('./queries.mjs');
        result = await (command === 'overview' ? inspectManagedWorkspace : listWorkingSessions)(options);
      }
      if (command === 'list') {
        const matched = values.query ? matchSessions(result.sessions, values.query) : null;
        const { harness, root, scope, currentProject, complete, warnings, unassignedCount, total, sessions, ...extra } = result;
        result = { harness, root, scope, currentProject, complete, warnings, unassignedCount,
          totalUnfiltered: total, total: matched ? matched.candidates.length : total, match: matched?.kind || null,
          sessions: matched?.candidates || sessions, ...extra };
      }
    } else {
      if ([values.id, values.query, options.currentSessionId].filter(value => value !== undefined).length !== 1) {
        throw fail('invalid_options', 'Provide exactly one of --id, --query or --current-session');
      }
      if (!values.execute && (values.expect || options.allowActive || options.allowUnknown || options.allowDescendants)) throw fail('invalid_options', 'Confirmation flags apply only with --execute');
      result = values.execute ? await executeManagedDelete(options) : await previewManagedDelete(options);
    }
    console.log(JSON.stringify(result, null, 2));
    if (['partial', 'failed', 'incomplete'].includes(result.status)) process.exitCode = 1;
  }
} catch (error) {
  console.log(JSON.stringify({ status: 'error', code: error.code || 'io_error', message: error.message, ...error.details }, null, 2));
  process.exitCode = 1;
}
