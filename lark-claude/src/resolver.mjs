import { resolveProject } from "./config.mjs";

function unique(rows, description) {
  if (rows.length === 1) return { value: rows[0] };
  if (rows.length > 1) return { question: `${description}存在多个匹配，请回复 Session Name 或 ID。` };
  return { question: `没有找到${description}，请回复 Session Name 或 ID。` };
}

export function buildRouterContext(config, store, message, internalSkills = null) {
  store.expireApprovals();
  const sessions = store.listSessions(config.gateway.recentSessionLimit).map((row) => ({
    id: row.id,
    name: row.name,
    executor: row.executor,
    project_alias: row.project_alias,
    status: row.status,
    last_summary: row.last_summary,
  }));
  const replySession = store.sessionForMessage(message.reply_to);
  return {
    projects: config.projects.map((project) => ({ alias: project.alias, aliases: project.aliases || [] })),
    recent_sessions: sessions,
    replied_session: replySession ? { id: replySession.id, name: replySession.name } : null,
    pending_approvals: store.listPendingApprovals().map((row) => ({ id: row.id, session_id: row.session_id, description: row.description })),
    internal_skills: internalSkills?.descriptors?.() || [],
  };
}

function resolveSession(intent, config, store, message) {
  const replied = store.sessionForMessage(message.reply_to);
  if (intent.session_ref) return unique(store.findSessions({ reference: intent.session_ref }), "指定的 Session");
  if (replied) return { value: replied };
  const project = intent.project_alias ? resolveProject(config, intent.project_alias) : null;
  const candidates = store.findSessions({ executor: intent.executor || null, projectAlias: project?.alias || null });
  return unique(candidates.slice(0, 1), "可继续的 Session");
}

export function resolveIntent(intent, config, store, message, internalSkills = null) {
  const overviewFields = ["overview_scope", "overview_executor", "project_query", "session_query"];
  if (intent.needs_clarification || intent.action === "clarify") {
    return { type: "reply", text: intent.clarification || "请补充执行器、项目或 Session。" };
  }
  if (intent.action !== "internal_skill"
    && (intent.skill_name != null || intent.ccswitch_action != null || intent.usage_period != null
      || overviewFields.some((field) => intent[field] != null))) {
    return { type: "reply", text: "内部技能查询不能与项目或 Session 操作混用。" };
  }
  if (["help", "unknown"].includes(intent.action)) return { type: intent.action };
  if (intent.action === "list") return { type: "list" };

  if (intent.skill_name !== "ccswitch"
    && (intent.ccswitch_action != null || intent.usage_period != null)) {
    return { type: "reply", text: "CC Switch 查询参数不能用于其他操作，请分开发送。" };
  }
  if (intent.skill_name !== "inspect_agent_workspace" && overviewFields.some((field) => intent[field] != null)) {
    return { type: "reply", text: "项目与 Session 概况参数不能用于其他操作，请分开发送。" };
  }

  if (intent.action === "internal_skill") {
    const commonForbidden = ["executor", "project_alias", "session_name", "request_ref", "content", "clarification"];
    if (!internalSkills?.has?.(intent.skill_name)) return { type: "unknown" };
    if (intent.skill_name === "inspect_agent_workspace") {
      const forbidden = [...commonForbidden, "session_ref", "ccswitch_action", "usage_period"];
      if (forbidden.some((field) => intent[field] != null)) {
        return { type: "reply", text: "请将项目与 Session 概况查询和其他操作分成两条消息发送。" };
      }
      const scope = intent.overview_scope;
      const overviewExecutor = intent.overview_executor;
      const projectQuery = intent.project_query?.trim() || null;
      const sessionQuery = intent.session_query?.trim() || null;
      const executorValid = overviewExecutor == null || ["claude", "codex"].includes(overviewExecutor);
      const scopeValid = scope === "all" ? !projectQuery && !sessionQuery
        : scope === "project" ? Boolean(projectQuery) && !sessionQuery
          : scope === "session" ? Boolean(sessionQuery) : false;
      if (!executorValid || !scopeValid) {
        return { type: "reply", text: "请明确要查询全部概况、一个项目，还是一个 Session。" };
      }
      return {
        type: "internal_skill",
        skillName: "inspect_agent_workspace",
        overviewScope: scope,
        overviewExecutor,
        projectQuery,
        sessionQuery,
      };
    }
    if (intent.skill_name === "stop_agent_session") {
      if ([...commonForbidden, ...overviewFields].some((field) => intent[field] != null)
        || !/^ST-[0-9A-F]{32}$/.test(intent.session_ref || "")) {
        return { type: "reply", text: "请先查询活动 Agent Session，再单独发送一个完整停止ID。" };
      }
      return { type: "internal_skill", skillName: intent.skill_name, sessionRef: intent.session_ref };
    }
    if (intent.skill_name === "ccswitch") {
      const forbidden = [...commonForbidden, "session_ref", ...overviewFields];
      if (forbidden.some((field) => intent[field] != null)) {
        return { type: "reply", text: "请将 CC Switch 查询与项目任务分成两条消息发送。" };
      }
      if (intent.ccswitch_action === "unsupported_mutation") {
        if (intent.usage_period != null) return { type: "unknown" };
        return { type: "reply", text: "CC Switch 技能当前仅支持只读查询，不会切换 Provider 或修改路由配置。" };
      }
      const actions = new Set(["overview", "providers", "health", "routing_status", "usage"]);
      if (!actions.has(intent.ccswitch_action)) return { type: "unknown" };
      if (intent.ccswitch_action !== "usage" && intent.usage_period != null) return { type: "unknown" };
      const usagePeriod = intent.ccswitch_action === "usage" ? (intent.usage_period || "today") : null;
      if (usagePeriod && !["today", "yesterday", "last_7_days", "last_30_days"].includes(usagePeriod)) {
        return { type: "unknown" };
      }
      return {
        type: "internal_skill",
        skillName: "ccswitch",
        ccswitchAction: intent.ccswitch_action,
        usagePeriod,
      };
    }
    const forbidden = [...commonForbidden, "session_ref", ...overviewFields];
    if (forbidden.some((field) => intent[field] != null)) {
      return { type: "reply", text: "请将 Agent Session 查询与项目任务分成两条消息发送。" };
    }
    return { type: "internal_skill", skillName: intent.skill_name };
  }

  if (["approve", "reject"].includes(intent.action)) {
    const pending = store.listPendingApprovals();
    const matches = intent.request_ref ? pending.filter((row) => row.id.toLowerCase() === intent.request_ref.toLowerCase()) : pending;
    const selected = unique(matches, "待确认请求");
    if (!selected.value) return { type: "reply", text: selected.question };
    return { type: intent.action, approval: selected.value };
  }

  if (intent.action === "new") {
    if (!intent.executor) return { type: "reply", text: "这项工作交给 Codex 还是 Claude？" };
    if (!intent.content?.trim()) return { type: "reply", text: "请说明要执行的具体任务。" };
    return {
      type: "lookup_new",
      action: "new",
      executor: intent.executor,
      project: null,
      projectQuery: intent.project_alias?.trim() || null,
      name: intent.session_name?.trim() || "未命名任务",
      content: intent.content.trim(),
    };
  }

  if (intent.action === "continue_or_create") {
    if (!intent.session_name?.trim()) return { type: "reply", text: "请提供要查找或创建的 Session 名称。" };
    if (!intent.content?.trim()) return { type: "reply", text: "请说明要继续处理的内容。" };
    return {
      type: "lookup",
      executor: intent.executor || null,
      project: null,
      projectQuery: intent.project_alias?.trim() || null,
      name: intent.session_name.trim(),
      content: intent.content.trim(),
    };
  }

  if (["continue", "status", "cancel"].includes(intent.action)) {
    const selected = resolveSession(intent, config, store, message);
    if (!selected.value) return { type: "reply", text: selected.question };
    if (intent.executor && selected.value.executor !== intent.executor) return { type: "reply", text: "指定执行器与 Session 不一致。" };
    const requestedProject = intent.project_alias ? resolveProject(config, intent.project_alias) : null;
    if (intent.project_alias && (!requestedProject || selected.value.project_alias.toLowerCase() !== requestedProject.alias.toLowerCase())) {
      return { type: "reply", text: "指定项目与 Session 不一致。" };
    }
    if (intent.action === "continue" && !intent.content?.trim()) return { type: "reply", text: "请说明要继续处理的内容。" };
    return { type: intent.action === "continue" ? "enqueue" : intent.action, action: intent.action, session: selected.value, content: intent.content?.trim() || "" };
  }

  return { type: "reply", text: "暂时无法识别这个操作，请说明要新建、继续、查看、取消还是批准任务。" };
}
