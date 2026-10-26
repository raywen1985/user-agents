import { collectCodexHistory } from "./session-catalog.mjs";
import { revalidateClaudeHistoryCandidate } from "./claude-session-history.mjs";
import {
  canonicalProjectDirectory,
  configuredProjectForPath,
  isExcludedProject,
  projectKey,
} from "./project-policy.mjs";

function sameProject(left, right) {
  return projectKey(left) === projectKey(right);
}

export async function revalidateProjectAuthority(session, {
  config,
  store,
  codexRoot,
} = {}) {
  let canonical;
  try { canonical = canonicalProjectDirectory(session?.project_path); } catch { return { ok: false, reason: "project_unverified" }; }
  if (!sameProject(canonical, session.project_path)) return { ok: false, reason: "stale_target" };
  if (isExcludedProject(config, canonical)) return { ok: false, reason: "project_excluded" };
  const authority = store.getProjectAuthority(session.id);
  if (!authority || !sameProject(authority.project_path, canonical) || authority.project_key !== projectKey(canonical)) {
    return { ok: false, reason: "project_unverified" };
  }
  if (authority.source_type === "override") {
    const override = configuredProjectForPath(config, canonical);
    return override && (!authority.override_alias || override.alias === authority.override_alias)
      ? { ok: true }
      : { ok: false, reason: "project_unverified" };
  }
  if (authority.source_type !== "native" || !authority.native_id) return { ok: false, reason: "project_unverified" };
  if (authority.provider === "claude") {
    return revalidateClaudeHistoryCandidate({
      executor: "claude",
      gatewayId: session.id,
      nativeId: authority.native_id,
      nativeName: null,
      projectPath: canonical,
      sourcePath: authority.source_path,
    });
  }
  if (authority.provider === "codex") {
    let result;
    try { result = await collectCodexHistory({ codexRoot }); } catch { return { ok: false, reason: "snapshot_incomplete" }; }
    if (!result.complete) return { ok: false, reason: "snapshot_incomplete" };
    const record = result.records.find((item) => item.nativeId === authority.native_id);
    let recordPath;
    try { recordPath = record?.cwd ? canonicalProjectDirectory(record.cwd) : null; } catch { recordPath = null; }
    return recordPath && sameProject(recordPath, canonical)
      ? { ok: true }
      : { ok: false, reason: "stale_target" };
  }
  return { ok: false, reason: "project_unverified" };
}

export function backfillOverrideAuthorities(config, store) {
  const rows = store.listSessionsBounded(20000);
  if (!rows.complete) throw new Error("Gateway session catalog exceeds the project-authority migration limit");
  for (const session of rows.records) {
    if (store.getProjectAuthority(session.id)) continue;
    let canonical;
    try { canonical = canonicalProjectDirectory(session.project_path); } catch { continue; }
    const override = configuredProjectForPath(config, canonical);
    if (!override || isExcludedProject(config, canonical)) continue;
    store.setProjectAuthority(session.id, override, {
      sourceType: "override",
      provider: null,
      nativeId: null,
      sourcePath: null,
      overrideAlias: override.alias,
    });
  }
}
