import fs from "node:fs";
import path from "node:path";
import { projectRoot } from "./config.mjs";
import { normalizeExactSessionName } from "./session-name-match.mjs";
import { lookupFailureText } from "./session-lookup-service.mjs";
import { candidateFailure, logLookupFailure, retrySnapshot } from "./lookup-observation.mjs";
import { canonicalProjectDirectory, projectKey } from "./project-policy.mjs";

const MESSAGE_ID = /^om_[A-Za-z0-9_-]{1,128}$/;
const NATIVE_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const UNKNOWN_NOTIFICATION_REPLY = "无法关联所回复消息的 Session（通知可能未保存绑定、已超过 30 天或已被轮转清理）。请取消回复后发送：codex/claude 会话名 任务内容。";
export const NOTIFICATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const bindingDirectory = path.join(projectRoot, "data", "notification-bindings");

function safeDirectory(directory) {
  const resolved = path.resolve(directory);
  let current = path.parse(resolved).root;
  for (const segment of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe binding directory");
  }
  return resolved;
}

function validRecord(record, messageId) {
  return record && [1, 2].includes(record.version) && record.messageId === messageId
    && ["codex", "claude"].includes(record.executor) && NATIVE_ID.test(record.nativeId)
    && /^ou_[A-Za-z0-9_-]{1,128}$/.test(record.recipientOpenId || "")
    && typeof record.chatId === "string" && (!record.chatId || /^oc_[A-Za-z0-9_-]{1,128}$/.test(record.chatId))
    && typeof record.createdAt === "string" && Number.isFinite(Date.parse(record.createdAt))
    && (record.projectPath == null || typeof record.projectPath === "string" && path.isAbsolute(record.projectPath));
}

export function pruneNotificationBindings({ directory = bindingDirectory, now = Date.now(), maxRecords = 5000 } = {}) {
  if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 5000 || !Number.isFinite(now)) throw new Error("Invalid binding cleanup limits");
  let root;
  try { root = safeDirectory(directory); } catch (error) {
    if (error.code === "ENOENT") return { removed: 0, kept: 0 };
    throw error;
  }
  const records = [];
  for (const name of fs.readdirSync(root)) {
    if (!/^om_[A-Za-z0-9_-]{1,128}\.json$/.test(name)) continue;
    const file = path.join(root, name), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    let record;
    try { if (stat.size <= 4096) record = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    const timestamp = validRecord(record, name.slice(0, -5)) ? Date.parse(record.createdAt) : 0;
    records.push({ file, timestamp, valid: timestamp > now - NOTIFICATION_TTL_MS && timestamp <= now + 60000 });
  }
  records.sort((a, b) => b.timestamp - a.timestamp || a.file.localeCompare(b.file));
  let kept = 0, removed = 0;
  for (const record of records) {
    if (record.valid && kept < maxRecords) { kept++; continue; }
    // Recheck the directory and entry immediately before unlinking.
    safeDirectory(root);
    const stat = fs.lstatSync(record.file);
    if (stat.isFile() && !stat.isSymbolicLink()) { fs.unlinkSync(record.file); removed++; }
  }
  return { removed, kept };
}

export function readNotificationBinding(message, {
  directory = bindingDirectory, now = Date.now(),
} = {}) {
  if (!MESSAGE_ID.test(message.reply_to || "")) return { kind: "missing" };
  let record;
  try {
    const file = path.join(safeDirectory(directory), `${message.reply_to}.json`);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return { kind: "invalid" };
    record = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return { kind: error.code === "ENOENT" ? "missing" : "invalid" };
  }
  if (!validRecord(record, message.reply_to) || Date.parse(record.createdAt) > now + 60000) return { kind: "invalid" };
  if (message.chat_type !== "p2p" || message.sender_type !== "user"
    || record.recipientOpenId !== message.sender_id || (record.chatId && record.chatId !== message.chat_id)) {
    return { kind: "forbidden" };
  }
  if (Date.parse(record.createdAt) <= now - NOTIFICATION_TTL_MS) return { kind: "expired" };
  return { kind: "bound", binding: Object.freeze(record) };
}

export function createNotificationReplyHandler({ config, store, scheduler, findNamedSession,
  revalidateNativeCandidate, codexRoot, claudeRoot, sendGlobal, queueCommitted }) {
  return async function handleNotificationReply(resolved, message) {
    const { binding, command, content } = resolved;
    const fail = (text, reason = "identity_conflict") => {
      logLookupFailure({ messageId: message.message_id, executor: binding.executor, reason });
      return sendGlobal(text, `notification-reply-${reason}-${message.message_id}`);
    };
    const unavailable = (reason) => reason === "busy"
      ? "通知对应的 Session 仍被原生客户端或 Gateway 占用。请等待任务结束并释放该会话后再回复；Claude Code 进程即使空闲，也需要先退出该会话。"
      : lookupFailureText(reason);
    if (store.taskForMessage(message.message_id)) return { ok: true, repeated: true };
    const found = await retrySnapshot(() => findNamedSession({
      config, store, executor: binding.executor, sessionName: binding.nativeId, codexRoot, claudeRoot,
    }));
    if (!found.complete) return fail(lookupFailureText("snapshot_incomplete"), "snapshot_incomplete");
    const candidates = found.candidates.filter((item) => item.executor === binding.executor && item.nativeId === binding.nativeId);
    if (!candidates.length) return fail(lookupFailureText("native_missing"), "native_missing");
    if (candidates.length !== 1) return fail(lookupFailureText("identity_conflict"));
    const candidate = candidates[0];
    if (binding.projectPath && candidate.projectPath) {
      try {
        if (projectKey(canonicalProjectDirectory(binding.projectPath)) !== projectKey(canonicalProjectDirectory(candidate.projectPath))) {
          return fail("通知记录的工程与当前原生会话工程不一致，请重新查询该会话。", "stale_target");
        }
      } catch { return fail(lookupFailureText("project_unverified"), "project_unverified"); }
    }
    if (command) {
      const requested = normalizeExactSessionName(command.sessionName)?.key;
      const names = [candidate.name, candidate.nativeName, candidate.nativeId, ...(candidate.aliases || [])];
      if (command.executor !== binding.executor || !names.some((name) => normalizeExactSessionName(name)?.key === requested)) {
        return fail("回复的通知与命令指定的 Session 不一致。请取消回复后重发，或直接回复任务内容。", "target_mismatch");
      }
    }
    if (candidate.busy || candidate.capability !== "ready") {
      return fail(unavailable(candidateFailure(candidate)), candidateFailure(candidate));
    }
    const checked = await retrySnapshot(() => revalidateNativeCandidate(candidate, { config, codexRoot, claudeRoot }));
    if (!checked.ok) return fail(unavailable(checked.reason), checked.reason);
    if (candidate.gatewayId && scheduler.canEnqueue?.(candidate.gatewayId) === false) {
      return fail("通知对应的 Session 正在停止，请稍后重试。", "stopping");
    }
    const project = candidate.project || (candidate.projectPath && candidate.projectAlias ? {
      alias: candidate.projectAlias, path: candidate.projectPath,
      authorities: candidate.authority ? [candidate.authority] : [],
    } : null);
    if (!project?.path || !project?.alias) return fail(lookupFailureText("project_unverified"), "project_unverified");
    const committed = store.commitNotificationTask({
      messageId: message.message_id, candidate, executor: binding.executor, project,
      name: candidate.name, content, action: "continue", approvalProfile: resolved.approvalProfile,
    });
    if (!committed.ok) return fail(unavailable(committed.reason), committed.reason);
    return queueCommitted(committed);
  };
}
