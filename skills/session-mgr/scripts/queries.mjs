// Public query API. No Gateway imports, database writes, resume or delete operations.
import path from 'node:path';
import { defaultRoot, resolveScope, canonicalProject, projectKey, byRecentActivity, matchSessions, fail } from './claude-reader.mjs';
import { resolveHarness } from './harnesses.mjs';
import { collectWorkspaceSnapshot } from './discovery/agent-workspace-overview.mjs';
import { collectActiveAgentSessionRecords } from './discovery/active-agent-sessions.mjs';

async function context(options) {
  const harness = resolveHarness(options.harness, options.runtimeEnv);
  if (harness === 'all' && options.root) throw fail('invalid_options', '--root requires one explicit harness');
  const scope = await resolveScope(options);
  return { harness, ...scope, executor: harness === 'all' ? null : harness,
    ...(options.root && harness === 'claude' ? { claudeRoot: defaultRoot(options.root) } : {}),
    ...(options.root && harness === 'codex' ? { codexRoot: defaultRoot(options.root) } : {}) };
}

async function select(sessions, ctx, query) {
  const normalized = await Promise.all(sessions.map(async item => ({ ...item,
    project: item.project ? await canonicalProject(item.project) : null,
    projects: await Promise.all((item.projects || (item.project ? [item.project] : [])).map(canonicalProject)),
  })));
  const scoped = normalized.filter(item => ctx.scope === 'all'
    || item.projects.some(project => projectKey(project) === projectKey(ctx.currentProject))).sort(byRecentActivity);
  const matched = query ? matchSessions(scoped, query) : null;
  return { totalUnfiltered: scoped.length, total: matched ? matched.candidates.length : scoped.length,
    match: matched?.kind || null, sessions: matched?.candidates || scoped };
}

export async function inspectManagedWorkspace(options = {}) {
  const ctx = await context(options);
  const snapshot = await (options.collectSnapshot || collectWorkspaceSnapshot)({
    ...options, ...ctx, overviewExecutor: ctx.executor,
  });
  const selected = await select(snapshot.sessions.map(item => ({
    harness: item.executor, id: item.nativeId || item.gatewayId, gatewayId: item.gatewayId,
    name: item.name, project: item.displayProjects?.length === 1 ? item.displayProjects[0] : null,
    projects: item.displayProjects || [], projectAlias: item.projectAlias,
    lastActiveAt: item.updatedAt ? new Date(item.updatedAt).toISOString() : null,
    activity: item.activity, resumeCapability: item.resumeCapability, ownerAvailable: item.ownerAvailable,
  })), ctx, options.query);
  const projects = new Map();
  for (const session of selected.sessions) {
    for (const project of session.projects) {
      if (ctx.scope === 'current' && projectKey(project) !== projectKey(ctx.currentProject)) continue;
      const key = projectKey(project);
      if (!projects.has(key)) projects.set(key, { path: project, name: path.basename(project), total: 0 });
      projects.get(key).total++;
    }
  }
  return { harness: ctx.harness, scope: ctx.scope, currentProject: ctx.currentProject,
    complete: snapshot.historyComplete && [snapshot.activity.completeness?.gateway,
      ...(ctx.executor ? [snapshot.activity.completeness?.[ctx.executor]]
        : [snapshot.activity.completeness?.claude, snapshot.activity.completeness?.codex])].every(Boolean),
    historyComplete: snapshot.historyComplete, warnings: snapshot.warnings,
    projects: [...projects.values()], ...selected };
}

export async function listWorkingSessions(options = {}) {
  const ctx = await context(options);
  const result = await (options.collectActive || collectActiveAgentSessionRecords)({ ...options, ...ctx });
  const selected = await select(result.records.filter(item => !ctx.executor || item.agent === ctx.executor).map(item => ({
    harness: item.agent, id: item.nativeId || item.sessionId, gatewayId: item.gatewayId || null,
    name: item.name || '未命名 Session', project: item.cwd,
    lastActiveAt: item.updatedAt ? new Date(item.updatedAt).toISOString() : null,
    activity: item.status, pid: item.pid,
  })), ctx, options.query);
  return { harness: ctx.harness, scope: ctx.scope, currentProject: ctx.currentProject,
    complete: Object.values(result.completeness).every(Boolean), warnings: result.warnings,
    additionalHidden: result.additionalHidden, ...selected };
}
