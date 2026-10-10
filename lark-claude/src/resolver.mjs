import { resolveProject } from "./config.mjs";

function unique(rows, description) {
  if (rows.length === 1) return { value: rows[0] };
  if (rows.length > 1) return { question: `${description}存在多个匹配，请回复 Session Name 或 ID。` };
  return { question: `没有找到${description}，请回复 Session Name 或 ID。` };
}

export function buildRouterContext(config, store, message) {
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

export function resolveIntent(intent, config, store, message) {
  if (intent.needs_clarification || intent.action === "clarify") {
    return { type: "reply", text: intent.clarification || "请补充执行器、项目或 Session。" };
  }
  if (["help", "unknown"].includes(intent.action)) return { type: intent.action };
  if (intent.action === "list") return { type: "list" };

  if (["approve", "reject"].includes(intent.action)) {
    const pending = store.listPendingApprovals();
    const matches = intent.request_ref ? pending.filter((row) => row.id.toLowerCase() === intent.request_ref.toLowerCase()) : pending;
    const selected = unique(matches, "待确认请求");
    if (!selected.value) return { type: "reply", text: selected.question };
    return { type: intent.action, approval: selected.value };
  }

  if (intent.action === "new") {
    if (!intent.executor) return { type: "reply", text: "这项工作交给 Codex 还是 Claude？" };
    const project = resolveProject(config, intent.project_alias);
    if (!project) return { type: "reply", text: "请明确一个已登记的项目别名。" };
    if (!intent.content?.trim()) return { type: "reply", text: "请说明要执行的具体任务。" };
    return {
      type: "enqueue",
      action: "new",
      executor: intent.executor,
      project,
      name: intent.session_name?.trim() || "未命名任务",
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
