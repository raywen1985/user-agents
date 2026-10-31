import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { defaultRoot, readClaudeEnvelope } from '../claude-reader.mjs';
import { canonicalProjectDirectory, isExcludedProject, projectFromPath, projectKey } from './project-policy.mjs';

export function readClaudeHistorySnapshot({ claudeRoot = defaultRoot(), timeoutMs = 15000,
  maximumProjectDirectories = 2048, maximumEntries = 20000, WorkerImpl = Worker } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const worker = new WorkerImpl(new URL('./claude-history-worker.mjs', import.meta.url), {
      workerData: { root: claudeRoot, maximumProjectDirectories, maximumEntries }, execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 192 },
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const incomplete = () => ({ complete: false, sessions: [], reason: 'snapshot_incomplete' });
    const timer = setTimeout(() => { worker.terminate(); finish(incomplete()); }, timeoutMs);
    worker.once('message', message => finish(message?.ok ? message.result : incomplete()));
    worker.once('error', () => finish(incomplete()));
    worker.once('exit', () => { if (!settled) finish(incomplete()); });
  });
}

export async function collectClaudeHistory({ claudeRoot = defaultRoot(),
  config = { projects: [], excludedRoots: [] }, readHistory = readClaudeHistorySnapshot, ...options } = {}) {
  const result = await readHistory({ claudeRoot, ...options });
  const records = [];
  for (const session of result.sessions || []) {
    const evidence = session.nativeEvidence || [];
    const sources = [...new Set((session.sources || []).filter(source =>
      path.basename(source).toLowerCase() === `${session.id}.jsonl` && source.split(/[\\/]/)[0] === 'projects'))];
    let project = null, sourcePath = null;
    // A list/index/runtime record is discoverable, but cannot authorize a resume.
    // The original native envelope establishes cwd. Later shell cwd/history
    // observations are display metadata, not competing project authorities.
    // Source uniqueness is global; never filter duplicates by a desired cwd.
    if (sources.length === 1) {
      try {
        const transcript = path.join(result.root || defaultRoot(claudeRoot), sources[0]);
        const envelope = await readClaudeEnvelope(transcript, session.id);
        const canonical = envelope.ok ? canonicalProjectDirectory(envelope.cwd) : null;
        if (canonical && evidence.some(item => item.source === sources[0] && projectKey(canonicalProjectDirectory(item.cwd)) === projectKey(canonical))
          && !isExcludedProject(config, canonical)) {
          sourcePath = transcript;
          project = projectFromPath(config, canonical, [{
            sourceType: 'native', provider: 'claude', nativeId: session.id, sourcePath,
          }], Date.parse(session.lastActiveAt || '') || null);
        }
      } catch {}
    }
    const knownPaths = session.projects || [];
    if (knownPaths.some(value => isExcludedProject(config, value))) continue;
    records.push({
      provider: 'claude', executor: 'claude', nativeId: session.id, sessionId: session.id,
      name: session.nameSource === 'unnamed' ? null : session.name, aliases: [],
      nameSource: session.nameSource, cwd: project?.path || null,
      projectAlias: project?.alias || null, projectPath: project?.path || null, project,
      // Display evidence only; never used as execution authority or cwd.
      observedProjects: [...knownPaths],
      authority: project?.authorities?.[0] || null, projectVerified: Boolean(project),
      capability: project ? 'ready' : 'project_unverified',
      updatedAt: Date.parse(session.lastActiveAt || session.updatedAt || '') || null,
      sourcePath, titlePath: null,
    });
  }
  return { records, complete: result.complete, reason: result.reason };
}

export async function collectClaudeHistoryForProject({ claudeRoot, project, ...options }) {
  const canonical = canonicalProjectDirectory(project.path);
  const result = await collectClaudeHistory({
    ...options, claudeRoot, config: { projects: [{ ...project, path: canonical }], excludedRoots: [] },
  });
  return { ...result, records: result.records.filter(record => record.projectPath && projectKey(record.projectPath) === projectKey(canonical)) };
}

export async function revalidateClaudeHistoryCandidate(candidate) {
  if (!candidate?.sourcePath || !candidate?.nativeId || !candidate?.projectPath) return { ok: false, reason: 'stale_target' };
  try {
    const claudeRoot = path.dirname(path.dirname(path.dirname(candidate.sourcePath)));
    const snapshot = await collectClaudeHistory({ claudeRoot });
    if (!snapshot.complete) return { ok: false, reason: 'snapshot_incomplete' };
    const current = snapshot.records.find(item => item.nativeId === candidate.nativeId);
    if (!current) return { ok: false, reason: 'native_missing' };
    if (!current.projectVerified || !current.sourcePath) return { ok: false, reason: 'identity_conflict' };
    if (projectKey(canonicalProjectDirectory(path.dirname(current.sourcePath)))
      !== projectKey(canonicalProjectDirectory(path.dirname(candidate.sourcePath)))) return { ok: false, reason: 'stale_target' };
    const envelope = await readClaudeEnvelope(candidate.sourcePath, candidate.nativeId);
    if (!envelope.ok) return { ok: false, reason: 'snapshot_incomplete' };
    const canonical = canonicalProjectDirectory(envelope.cwd);
    if (projectKey(canonical) !== projectKey(candidate.projectPath)) return { ok: false, reason: 'stale_target' };
    return { ok: true };
  } catch { return { ok: false, reason: 'snapshot_incomplete' }; }
}
