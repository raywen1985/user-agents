import { buildRouterContext, resolveIntent } from "./resolver.mjs";
import { approvalProfileForTypedTask, parseApprovalControl } from "./approval-control.mjs";
import { parseSessionCommand } from "./session-command-parser.mjs";
import { parseSessionListQuery } from "./session-list.mjs";
import { normalizeExactSessionName } from "./session-name-match.mjs";
import { resolveCandidateSelection } from "./session-lookup-service.mjs";
import { readNotificationBinding, UNKNOWN_NOTIFICATION_REPLY } from "./notification-replies.mjs";
import { parseOffWorkCommand } from "./off-work.mjs";

function syntaxError(parsed) {
  const example = parsed.executor === "claude"
    ? "claude 会话名 检查是否需要提交"
    : "codex 会话名 检查并修复问题";
  return `命令格式：<claude|codex> <session-name> <任务内容>\n新建格式：<claude|codex> <新建|new> <session-name> <任务内容>\n例如：${example}`;
}

function projectContext(store, session) {
  if (!session?.project_path || !session?.project_alias) return null;
  const authority = store.getProjectAuthority?.(session.id);
  return {
    alias: session.project_alias,
    display: session.project_alias,
    key: session.project_path.toLowerCase(),
    path: session.project_path,
    authorities: authority ? [{
      sourceType: authority.source_type,
      provider: authority.provider,
      nativeId: authority.native_id,
      sourcePath: authority.source_path,
      overrideAlias: authority.override_alias,
    }] : [],
  };
}

function commandConflict(parsed, replied) {
  if (!replied || parsed.type !== "continue-or-create") return false;
  const requested = normalizeExactSessionName(parsed.sessionName);
  const actual = normalizeExactSessionName(replied.name);
  return replied.executor !== parsed.executor || !requested || !actual || requested.key !== actual.key;
}

export function createMessageCoordinator({ config, store, router, internalSkills = null, notificationBinding = readNotificationBinding }) {
  async function coordinate(message) {
    const offWork = parseOffWorkCommand(message.content, message.message_type || 'text');
    if (offWork) return offWork;
    const approval = parseApprovalControl(message.content, message.message_type || "text");
    if (approval?.type === "invalid-approval") {
      return { type: "reply", text: "审批命令格式：批准 RQ-...、拒绝 RQ-...；回复审批消息还可发送“批准同类”或“全部批准”。" };
    }
    if (approval?.type === "approve" || approval?.type === "reject") {
      const row = store.getApproval(approval.requestRef);
      if (!row || row.status !== "pending") return { type: "reply", text: `请求 ${approval.requestRef} 不存在或已处理。` };
      return { type: approval.type, approval: row };
    }
    if (approval?.type === "approve-scope") {
      const row = store.approvalForMessage(message.reply_to);
      if (!row) return { type: "reply", text: "请使用飞书的“回复”功能回复仍然有效的审批消息。" };
      return { type: "approve_scope", mode: approval.mode, approval: row };
    }
    const parsed = parseSessionCommand(message.content);

    if (message.reply_to && !store.sessionForMessage(message.reply_to) && !store.candidateSetForReply(message.reply_to)) {
      const notification = await notificationBinding(message);
      if (notification.kind !== "bound") return { type: "reply", text: notification.kind === "forbidden"
        ? "该通知不属于当前聊天或发送者，未执行。" : UNKNOWN_NOTIFICATION_REPLY };
      if (parsed.type === "create-new") return { type: "reply", text: "回复通知用于继续原 Session；新建会话请取消回复后发送 new/新建 命令。" };
      if (parsed.type === "invalid-command") return { type: "reply", text: syntaxError(parsed) };
      const command = parsed.type === "continue-or-create" ? parsed : null;
      const content = command ? command.content : message.content;
      return { type: "notification_reply", binding: notification.binding, command, content,
        approvalProfile: approvalProfileForTypedTask(content, message.message_type || "text") };
    }

    if (["number-selection", "page-navigation"].includes(parsed.type)) {
      const selection = resolveCandidateSelection(store, message);
      if (selection.kind === "ambiguous") {
        return { type: "reply", text: "当前聊天有多个有效候选列表，请使用飞书的“回复”功能回复目标候选消息中的编号。" };
      }
      if (selection.kind !== "selected") {
        return { type: "reply", text: "当前没有可操作的候选列表，请重新发送原命令。" };
      }
      return parsed.type === "page-navigation"
        ? { type: "candidate_navigation", binding: selection.binding, direction: parsed.direction }
        : { type: "candidate_reply", binding: selection.binding };
    }

    const sessionList = parseSessionListQuery(message.content);
    if (sessionList) return sessionList;

    if (parsed.type === "invalid-command") return { type: "reply", text: syntaxError(parsed) };

    if (["continue-or-create", "create-new"].includes(parsed.type)) {
      const replied = store.sessionForMessage(message.reply_to);
      if (commandConflict(parsed, replied)) {
        return { type: "reply", text: "回复的 Session 与命令中指定的执行器或名称不一致。请取消回复后重发，或使用回复 Session 的名称。" };
      }
      const recent = !replied ? store.recentSessionContext({ chatId: message.chat_id, senderId: message.sender_id }) : null;
      const contextSession = replied || (recent ? store.getSession(recent.session_id) : null);
      if (parsed.type === "continue-or-create" && replied) {
        return {
          type: "enqueue",
          action: "continue",
          session: replied,
          content: parsed.content,
          approvalProfile: approvalProfileForTypedTask(parsed.content, message.message_type || "text"),
        };
      }
      return {
        type: parsed.type === "create-new" ? "lookup_new" : "lookup",
        action: parsed.type === "create-new" ? "new" : "continue_or_create",
        executor: parsed.executor,
        project: parsed.type === "create-new" ? projectContext(store, contextSession) : null,
        creationProject: projectContext(store, contextSession),
        projectQuery: null,
        name: parsed.sessionName,
        content: parsed.content,
        approvalProfile: approvalProfileForTypedTask(parsed.content, message.message_type || "text"),
      };
    }

    const context = buildRouterContext(config, store, message, internalSkills);
    const intent = await router.route(message, context);
    if (intent.skill_name === 'off_work') return { type: 'reply', text: '请单独发送文字“下班检查”查看，或“下班”关闭所有已识别 Agent 客户端。' };
    if (["approve", "reject"].includes(intent.action)) {
      return { type: "reply", text: "审批只接受明确的文字命令：批准 RQ-... 或拒绝 RQ-...。" };
    }
    if (intent.action === "continue" && !intent.session_ref && intent.content?.trim()) {
      const replied = store.sessionForMessage(message.reply_to);
      if (!replied) {
        const recent = store.recentSessionContext({ chatId: message.chat_id, senderId: message.sender_id });
        if (recent) {
          intent.session_ref = recent.session_id;
          intent.executor ||= recent.executor;
        } else {
          return {
            type: "lookup_unnamed",
            executor: intent.executor || null,
            content: intent.content.trim(),
          };
        }
      }
    }
    return resolveIntent(intent, config, store, message, internalSkills);
  }

  return Object.freeze({ coordinate });
}
