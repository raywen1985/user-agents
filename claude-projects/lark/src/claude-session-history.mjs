import fsp from "node:fs/promises";
import path from "node:path";
import { canonicalProjectDirectory, isExcludedProject, projectFromPath } from "./project-policy.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sameWindowsPath(left, right) {
  return path.resolve(left).replaceAll("/", "\\").toLowerCase()
    === path.resolve(right).replaceAll("/", "\\").toLowerCase();
}

async function regularFile(filePath, maximumBytes) {
  let stat;
  try { stat = await fsp.lstat(filePath); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maximumBytes) return null;
  return stat;
}

async function regularDirectory(directoryPath) {
  let stat;
  try { stat = await fsp.lstat(directoryPath); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  return !stat.isSymbolicLink() && stat.isDirectory() ? stat : null;
}

async function readTitle(filePath) {
  const stat = await regularFile(filePath, 4096);
  if (!stat) return null;
  let payload;
  try { payload = JSON.parse(await fsp.readFile(filePath, "utf8")); } catch { return null; }
  if (!payload || Object.keys(payload).some((key) => key !== "customTitle")
    || typeof payload.customTitle !== "string" || !payload.customTitle.trim()) return null;
  return { name: payload.customTitle.trim(), updatedAt: stat.mtimeMs };
}

async function readEnvelope(transcriptPath, sessionId, maximumBytes = 262144, maximumLines = 64) {
  const stat = await regularFile(transcriptPath, Number.MAX_SAFE_INTEGER);
  if (!stat) return { ok: false, reason: "missing_transcript" };
  const handle = await fsp.open(transcriptPath, "r");
  try {
    const length = Math.min(stat.size, maximumBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    const text = buffer.toString("utf8");
    const lines = text.split(/\r?\n/).slice(0, maximumLines);
    for (const line of lines) {
      if (!line.trim()) continue;
      let payload;
      try { payload = JSON.parse(line); } catch { continue; }
      if (String(payload.sessionId || "").toLowerCase() !== sessionId) continue;
      if (typeof payload.cwd !== "string" || !path.isAbsolute(payload.cwd)) continue;
      return { ok: true, cwd: payload.cwd, updatedAt: Date.parse(payload.timestamp || "") || stat.mtimeMs };
    }
    return { ok: false, reason: stat.size > maximumBytes ? "metadata_prefix_exceeded" : "project_unverified" };
  } finally {
    await handle.close();
  }
}

export async function collectClaudeHistory({
  claudeRoot,
  config = { projects: [], excludedRoots: [] },
  maximumProjectDirectories = 2048,
  maximumEntries = 20000,
} = {}) {
  const projectsRoot = path.join(claudeRoot, "projects");
  let rootStat;
  try { rootStat = await fsp.lstat(projectsRoot); } catch (error) {
    if (error.code === "ENOENT") return { records: [], complete: true };
    throw error;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return { records: [], complete: false, reason: "unsafe_project_history" };

  const records = [];
  let seenProjects = 0;
  let seenEntries = 0;
  const roots = await fsp.opendir(projectsRoot);
  try {
    for await (const rootEntry of roots) {
      if (!rootEntry.isDirectory()) continue;
      seenProjects += 1;
      if (seenProjects > maximumProjectDirectories) return { records, complete: false, reason: "project_history_limit" };
      const historyRoot = path.join(projectsRoot, rootEntry.name);
      if (!await regularDirectory(historyRoot)) return { records, complete: false, reason: "unsafe_project_history" };
      const directory = await fsp.opendir(historyRoot);
      try {
        for await (const entry of directory) {
          seenEntries += 1;
          if (seenEntries > maximumEntries) return { records, complete: false, reason: "history_limit" };
          const match = entry.isFile() && entry.name.match(/^([0-9a-f-]{36})\.jsonl$/i);
          if (!match || !UUID_PATTERN.test(match[1])) continue;
          const nativeId = match[1].toLowerCase();
          const titlePath = path.join(historyRoot, nativeId, "custom-title.json");
          const title = await readTitle(titlePath);
          const transcriptPath = path.join(historyRoot, entry.name);
          const envelope = await readEnvelope(transcriptPath, nativeId);
          let project = null;
          if (envelope.ok) {
            try {
              const canonical = canonicalProjectDirectory(envelope.cwd);
              if (!isExcludedProject(config, canonical)) {
                const authority = {
                  sourceType: "native",
                  provider: "claude",
                  nativeId,
                  sourcePath: transcriptPath,
                };
                project = projectFromPath(config, canonical, [authority], envelope.updatedAt);
              }
            } catch {}
          }
          records.push({
            provider: "claude",
            executor: "claude",
            nativeId,
            sessionId: nativeId,
            name: title?.name || null,
            aliases: [],
            cwd: project?.path || null,
            projectAlias: project?.alias || null,
            projectPath: project?.path || null,
            project,
            authority: project?.authorities?.[0] || null,
            projectVerified: Boolean(project),
            capability: project ? "ready" : "project_unverified",
            updatedAt: Math.max(Number(title?.updatedAt || 0), Number(envelope.updatedAt || 0)) || null,
            sourcePath: transcriptPath,
            titlePath,
          });
        }
      } finally {
        await directory.close().catch(() => {});
      }
    }
  } finally {
    await roots.close().catch(() => {});
  }
  return { records, complete: true };
}

export async function collectClaudeHistoryForProject({ claudeRoot, project, maximumEntries = 20000 }) {
  const canonicalProject = canonicalProjectDirectory(project.path);
  const result = await collectClaudeHistory({
    claudeRoot,
    config: { projects: [{ ...project, path: canonicalProject }], excludedRoots: [] },
    maximumEntries,
  });
  return {
    ...result,
    records: result.records.filter((record) => record.projectPath && sameWindowsPath(record.projectPath, canonicalProject)),
  };
}

export async function revalidateClaudeHistoryCandidate(candidate) {
  if (!candidate?.sourcePath || !candidate?.nativeId || !candidate?.projectPath) {
    return { ok: false, reason: "stale_target" };
  }
  if (candidate.nativeName) {
    if (!candidate.titlePath) return { ok: false, reason: "stale_target" };
    const title = await readTitle(candidate.titlePath);
    if (!title || title.name !== candidate.nativeName) return { ok: false, reason: "stale_target" };
  } else if (!candidate.gatewayId) {
    return { ok: false, reason: "stale_target" };
  }
  const envelope = await readEnvelope(candidate.sourcePath, candidate.nativeId);
  if (!envelope.ok) return { ok: false, reason: "snapshot_incomplete" };
  let canonical;
  try { canonical = canonicalProjectDirectory(envelope.cwd); } catch { return { ok: false, reason: "stale_target" }; }
  if (!sameWindowsPath(canonical, candidate.projectPath)) return { ok: false, reason: "stale_target" };
  return { ok: true };
}

