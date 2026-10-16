import { collectActiveAgentSessionRecords } from "./active-agent-sessions.mjs";
import { buildSessionCatalog } from "./session-catalog.mjs";
import { displaySessionName, matchSessionName } from "./session-name-match.mjs";
import { matchProjects, projectKey } from "./project-policy.mjs";
import { compactOneLine } from "./sanitize.mjs";

const ACTIVITY_ORDER = Object.freeze({ waiting_approval: 0, running: 1, queued: 2, unknown: 3, idle: 4 });
const RESUME_ORDER = Object.freeze({ busy: 0, unavailable: 1, resumable: 2 });
const CONTROL_OR_BIDI = /[\p{Cc}\p{Cs}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

function ordinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function lower(value) {
  return String(value || "").trim().toLowerCase();
}

function safeQuery(value) {
  const text = String(value || "").normalize("NFKC").trim();
  return text && [...text].length <= 160 && !CONTROL_OR_BIDI.test(text) ? text : null;
}

function sameProject(left, right) {
  if (!left || !right) return false;
  try { return projectKey(left) === projectKey(right); } catch { return false; }
}

function executorLabel(value) {
  return value === "claude" ? "Claude Code" : "Codex";
}

function phase(value) {
  if (value === "waiting_approval" || value === "waiting_input") return "waiting_approval";
  if (value === "queued") return "queued";
  return "running";
}

function phaseLabel(value) {
  return {
    waiting_approval: "等待输入/批准",
    running: "运行中",
    queued: "排队中",
    idle: "空闲",
    unknown: "未知",
  }[value] || "未知";
}

function resumeLabel(value) {
  return { resumable: "可恢复", busy: "占用中", unavailable: "不可用" }[value] || "不可用";
}

function formatTime(value) {
  const timestamp = Number(value || 0);
  if (!timestamp) return "未知";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(timestamp));
  } catch {
    return "未知";
  }
}

function activeRecordOrder(left, right) {
  return (ACTIVITY_ORDER[phase(left.status)] ?? 99) - (ACTIVITY_ORDER[phase(right.status)] ?? 99)
    || Number(right.updatedAt || 0) - Number(left.updatedAt || 0)
    || ordinal(String(left.gatewayId || left.sessionId || ""), String(right.gatewayId || right.sessionId || ""));
}

function activeIndex(records) {
  const index = new Map();
  const add = (key, record) => {
    if (!key) return;
    const prior = index.get(key);
    if (!prior || activeRecordOrder(record, prior) < 0) index.set(key, record);
  };
  for (const record of records || []) {
    const executor = record.agent === "claude" ? "claude" : "codex";
    if (record.nativeId) add(`native:${executor}:${lower(record.nativeId)}`, record);
    for (const gatewayId of [record.gatewayId, record.sessionId, ...(record.gatewayIds || [])]) {
      if (gatewayId) add(`gateway:${lower(gatewayId)}`, record);
    }
  }
  return index;
}

function activeFor(candidate, index) {
  if (candidate.gatewayId) {
    const record = index.get(`gateway:${lower(candidate.gatewayId)}`);
    if (record) return record;
  }
  return candidate.nativeId ? index.get(`native:${candidate.executor}:${lower(candidate.nativeId)}`) || null : null;
}

function hasNativeEvidence(candidate) {
  const provider = String(candidate.provider || "");
  return provider === candidate.executor || provider.includes(`+${candidate.executor}`);
}

function ownershipAvailable(candidate) {
  if (!candidate.projectPath || ["identity_conflict", "project_unverified"].includes(candidate.capability)) return false;
  if (hasNativeEvidence(candidate)) return true;
  return candidate.provider === "gateway" && candidate.authority?.sourceType === "override";
}

function activityEvidenceComplete(candidate, completeness) {
  if (candidate.gatewayId && !completeness.gateway) return false;
  if (candidate.nativeId && !completeness[candidate.executor]) return false;
  return true;
}

function decorateSessions(candidates, active, activityCompleteness) {
  const index = activeIndex(active);
  return (candidates || []).map((candidate) => {
    const current = activeFor(candidate, index);
    const activity = current ? phase(current.status)
      : activityEvidenceComplete(candidate, activityCompleteness) ? "idle" : "unknown";
    const ownerAvailable = ownershipAvailable(candidate);
    const resumeCapability = current || candidate.busy ? "busy"
      : activity === "unknown" || !ownerAvailable || candidate.capability !== "ready" ? "unavailable" : "resumable";
    return Object.freeze({ ...candidate, activity, resumeCapability, ownerAvailable });
  });
}

function sessionOrder(left, right) {
  return (ACTIVITY_ORDER[left.activity] ?? 99) - (ACTIVITY_ORDER[right.activity] ?? 99)
    || Number(right.updatedAt || 0) - Number(left.updatedAt || 0)
    || ordinal(String(left.executor || ""), String(right.executor || ""))
    || ordinal(lower(left.name), lower(right.name))
    || ordinal(lower(left.gatewayId || left.nativeId), lower(right.gatewayId || right.nativeId));
}

function countBy(values, keys) {
  const counts = Object.fromEntries(keys.map((key) => [key, 0]));
  for (const value of values) counts[value] = (counts[value] || 0) + 1;
  return counts;
}

function buildProjects(projects, sessions) {
  return (projects || []).map((project) => {
    const owned = sessions.filter((session) => session.ownerAvailable && sameProject(session.projectPath, project.path));
    return Object.freeze({
      ...project,
      sessions: Object.freeze(owned.sort(sessionOrder)),
      updatedAt: Math.max(Number(project.updatedAt || 0), ...owned.map((item) => Number(item.updatedAt || 0))) || null,
      executorCounts: countBy(owned.map((item) => item.executor), ["claude", "codex"]),
      activityCounts: countBy(owned.map((item) => item.activity), ["waiting_approval", "running", "queued", "idle", "unknown"]),
      resumeCounts: countBy(owned.map((item) => item.resumeCapability), ["resumable", "busy", "unavailable"]),
    });
  }).sort((left, right) => {
    const leftActive = left.activityCounts.waiting_approval + left.activityCounts.running + left.activityCounts.queued;
    const rightActive = right.activityCounts.waiting_approval + right.activityCounts.running + right.activityCounts.queued;
    return rightActive - leftActive
      || Number(right.updatedAt || 0) - Number(left.updatedAt || 0)
      || ordinal(lower(left.display || left.label), lower(right.display || right.label))
      || ordinal(lower(left.path), lower(right.path));
  });
}

function relevantProviders(executor) {
  return executor ? [executor] : ["claude", "codex"];
}

function historyComplete(catalog, executor) {
  if (!catalog.completeness?.gateway) return false;
  return relevantProviders(executor).every((provider) => catalog.completeness?.[provider]);
}

function anyHistorySourceComplete(catalog, executor) {
  return Boolean(catalog.completeness?.gateway
    || relevantProviders(executor).some((provider) => catalog.completeness?.[provider]));
}

function warningsFor(catalog, activity, executor) {
  const historyMissing = [];
  if (!catalog.completeness?.gateway) historyMissing.push("Gateway");
  for (const provider of relevantProviders(executor)) {
    if (!catalog.completeness?.[provider]) historyMissing.push(executorLabel(provider));
  }
  const activityMissing = [];
  if (!activity.completeness?.gateway) activityMissing.push("Gateway");
  for (const provider of relevantProviders(executor)) {
    if (!activity.completeness?.[provider]) activityMissing.push(executorLabel(provider));
  }
  const warnings = [];
  if (historyMissing.length) warnings.push(`会话目录不完整：${historyMissing.join("、")}`);
  if (activityMissing.length) warnings.push(`活动状态不完整：${activityMissing.join("、")}`);
  return warnings;
}

function finish(lines, warnings, maxLength) {
  for (const warning of warnings.slice(0, 3)) lines.push(`警告：${compactOneLine(warning, 200)}`);
  const text = lines.join("\n");
  return text.length > maxLength ? `${text.slice(0, maxLength - 16)}\n... 输出已截断` : text;
}

function shortId(session) {
  const value = String(session.gatewayId || session.nativeId || "-");
  return value.length > 24 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value;
}

function sessionCandidateLine(session, index = null) {
  const prefix = index == null ? "-" : `${index}.`;
  const project = session.ownerAvailable ? (session.projectDisplay || session.projectAlias || session.projectPath) : "归属未知";
  return `${prefix} ${executorLabel(session.executor)} | ${displaySessionName(session.name)} | ${compactOneLine(project, 180)} | ${shortId(session)}`;
}

function projectCandidateLines(projects, provisional = false) {
  const heading = provisional ? "当前仅能确认以下已观察项目，数据源不完整，不能判定唯一：" : "找到多个项目，请补充更明确的项目别名：";
  return [heading, ...projects.slice(0, 30).map((project, index) => `${index + 1}. ${compactOneLine(project.display || project.label, 80)} | ${compactOneLine(project.path, 180)}`)];
}

function sessionCandidateLines(sessions, provisional = false) {
  const heading = provisional ? "当前仅能确认以下已观察会话，数据源不完整，不能判定唯一：" : "找到多个会话，请补充项目、执行器或完整会话 ID：";
  return [heading, ...sessions.slice(0, 30).map((session, index) => sessionCandidateLine(session, index + 1))];
}

function formatAll(snapshot) {
  const sessions = snapshot.sessions;
  const activities = countBy(sessions.map((item) => item.activity), ["waiting_approval", "running", "queued", "idle", "unknown"]);
  const resumes = countBy(sessions.map((item) => item.resumeCapability), ["resumable", "busy", "unavailable"]);
  const executors = countBy(sessions.map((item) => item.executor), ["claude", "codex"]);
  const unassigned = sessions.filter((item) => !item.ownerAvailable).length;
  const partial = snapshot.historyComplete ? "" : "（仅已观察数据）";
  const lines = [
    `本机 Agent 项目与会话概况${partial}`,
    `项目 ${snapshot.projects.length} | 会话 ${sessions.length} | Claude Code ${executors.claude} | Codex ${executors.codex}`,
    `活动：等待 ${activities.waiting_approval} | 运行 ${activities.running} | 排队 ${activities.queued} | 空闲 ${activities.idle} | 未知 ${activities.unknown}`,
    `恢复：可恢复 ${resumes.resumable} | 占用 ${resumes.busy} | 不可用 ${resumes.unavailable} | 归属未知 ${unassigned}`,
    `最近活动：${formatTime(Math.max(0, ...sessions.map((item) => Number(item.updatedAt || 0))))}`,
  ];
  const shown = snapshot.projects.slice(0, 30);
  if (shown.length) lines.push("项目：");
  for (const project of shown) {
    const active = project.activityCounts.waiting_approval + project.activityCounts.running + project.activityCounts.queued;
    lines.push(`- ${compactOneLine(project.display || project.label, 80)} | Claude ${project.executorCounts.claude} / Codex ${project.executorCounts.codex} | 活跃 ${active} / 总计 ${project.sessions.length} | ${formatTime(project.updatedAt)}`);
  }
  if (snapshot.projects.length > shown.length) lines.push(`... 另有 ${snapshot.projects.length - shown.length} 个项目未显示`);
  return lines;
}

function formatProject(project) {
  const lines = [
    `项目概况：${compactOneLine(project.display || project.label, 80)}`,
    `路径：${compactOneLine(project.path, 180)}`,
    `会话：${project.sessions.length} | Claude Code ${project.executorCounts.claude} | Codex ${project.executorCounts.codex}`,
    `活动：等待 ${project.activityCounts.waiting_approval} | 运行 ${project.activityCounts.running} | 排队 ${project.activityCounts.queued} | 空闲 ${project.activityCounts.idle} | 未知 ${project.activityCounts.unknown}`,
    `恢复：可恢复 ${project.resumeCounts.resumable} | 占用 ${project.resumeCounts.busy} | 不可用 ${project.resumeCounts.unavailable}`,
    `最近活动：${formatTime(project.updatedAt)}`,
  ];
  const shown = project.sessions.slice(0, 30);
  if (shown.length) lines.push("会话：");
  for (const session of shown) {
    lines.push(`- ${executorLabel(session.executor)} | ${displaySessionName(session.name)} | 活动 ${phaseLabel(session.activity)} | 恢复 ${resumeLabel(session.resumeCapability)} | ${shortId(session)} | ${formatTime(session.updatedAt)}`);
  }
  if (!shown.length) lines.push("当前没有已发现会话。");
  if (project.sessions.length > shown.length) lines.push(`... 另有 ${project.sessions.length - shown.length} 个会话未显示`);
  return lines;
}

function formatSession(session) {
  const provider = String(session.provider || "").replace("gateway", "Gateway").replace("claude", "Claude Code").replace("codex", "Codex");
  const lines = [
    `会话详情：${displaySessionName(session.name)}`,
    `执行器：${executorLabel(session.executor)} | 来源：${provider || "未知"}`,
    session.ownerAvailable
      ? `项目：${compactOneLine(session.projectDisplay || session.projectAlias || session.projectPath, 80)} | ${compactOneLine(session.projectPath, 180)}`
      : "项目：归属不可用（当前元数据无法验证）",
    `活动：${phaseLabel(session.activity)} | 恢复：${resumeLabel(session.resumeCapability)}`,
    `最近活动：${formatTime(session.updatedAt)}`,
  ];
  if (session.gatewayId) lines.push(`Gateway ID：${compactOneLine(session.gatewayId, 80)}`);
  if (session.nativeId) lines.push(`原生 ID：${compactOneLine(session.nativeId, 80)}`);
  lines.push("说明：仅使用本机会话元数据，未读取提示词、回复或会话正文。");
  return lines;
}

function exactIdMatches(query, sessions) {
  const needle = lower(query);
  return sessions.filter((session) => [session.gatewayId, session.nativeId].some((value) => lower(value) === needle));
}

function exactIdentityComplete(query, session, completeness, executor) {
  if (lower(session.gatewayId) === lower(query)) return Boolean(completeness.gateway);
  if (executor) return Boolean(completeness[executor]);
  return Boolean(completeness.claude && completeness.codex);
}

export function createAgentWorkspaceOverview({
  config,
  store,
  codexRoot,
  claudeRoot,
  buildCatalog = buildSessionCatalog,
  collectActive = collectActiveAgentSessionRecords,
  maxLength = 12000,
} = {}) {
  return async function inspectAgentWorkspace({
    overviewScope,
    overviewExecutor = null,
    projectQuery = null,
    sessionQuery = null,
    gatewayActivities = [],
    gatewayTruncated = false,
  } = {}) {
    const [catalogResult, activityResult] = await Promise.allSettled([
      buildCatalog({ config, store, executor: overviewExecutor, codexRoot, claudeRoot }),
      collectActive({
        gatewayActivities,
        gatewayTruncated,
        codexRoot,
        claudeRoot,
        aggregateLimit: 20000,
        executor: overviewExecutor,
      }),
    ]);
    if (catalogResult.status === "rejected") return "Agent 项目与会话概况查询失败：会话目录不可用。";
    const catalog = catalogResult.value;
    const activity = activityResult.status === "fulfilled" ? activityResult.value : {
      records: [],
      completeness: { gateway: false, claude: false, codex: false },
    };
    const activityCompleteness = activity.completeness || { gateway: false, claude: false, codex: false };
    const sessions = decorateSessions(catalog.candidates, activity.records, activityCompleteness).sort(sessionOrder);
    const projects = buildProjects(catalog.projects, sessions);
    const complete = historyComplete(catalog, overviewExecutor);
    const warnings = warningsFor(catalog, activity, overviewExecutor);
    const snapshot = { sessions, projects, historyComplete: complete };

    if (!anyHistorySourceComplete(catalog, overviewExecutor)) {
      return finish(["Agent 项目与会话概况查询失败：相关会话目录均不可用。"], warnings, maxLength);
    }

    if (overviewScope === "all") return finish(formatAll(snapshot), warnings, maxLength);

    const normalizedProjectQuery = projectQuery == null ? null : safeQuery(projectQuery);
    if (projectQuery != null && !normalizedProjectQuery) {
      return finish(["项目名称无效；请使用项目别名或目录名称，不要提供路径。"], warnings, maxLength);
    }

    let scopedSessions = sessions;
    if (overviewScope === "project" || normalizedProjectQuery) {
      const matched = matchProjects(normalizedProjectQuery, projects);
      if (matched.kind === "invalid") return finish(["项目名称无效。"], warnings, maxLength);
      if (matched.kind === "none") {
        const text = complete ? "没有找到该项目。" : "已完成的数据源中没有找到该项目；当前扫描不完整，无法确认项目不存在。";
        return finish([text], warnings, maxLength);
      }
      if (matched.kind === "selection") return finish(projectCandidateLines(matched.projects), warnings, maxLength);
      if (!complete) return finish(projectCandidateLines([matched.project], true), warnings, maxLength);
      if (overviewScope === "project") return finish(formatProject(matched.project), warnings, maxLength);
      scopedSessions = sessions.filter((session) => session.ownerAvailable && sameProject(session.projectPath, matched.project.path));
    }

    const query = safeQuery(sessionQuery);
    if (!query) return finish(["会话名称或 ID 无效。"], warnings, maxLength);
    const exact = exactIdMatches(query, scopedSessions);
    if (exact.length > 1) return finish(sessionCandidateLines(exact), warnings, maxLength);
    if (exact.length === 1) {
      if (!exactIdentityComplete(query, exact[0], catalog.completeness || {}, overviewExecutor)) {
        return finish(sessionCandidateLines(exact, true), warnings, maxLength);
      }
      return finish(formatSession(exact[0]), warnings, maxLength);
    }

    const matched = matchSessionName(query, scopedSessions);
    if (matched.kind === "invalid") return finish(["会话名称无效。"], warnings, maxLength);
    if (matched.kind === "none") {
      const text = complete ? "没有找到该会话。" : "已完成的数据源中没有找到该会话；当前扫描不完整，无法确认会话不存在。";
      return finish([text], warnings, maxLength);
    }
    const observed = matched.matches.map((item) => item.candidate);
    if (!complete) return finish(sessionCandidateLines(observed, true), warnings, maxLength);
    if (matched.kind === "selection") return finish(sessionCandidateLines(observed), warnings, maxLength);
    return finish(formatSession(matched.selected), warnings, maxLength);
  };
}
