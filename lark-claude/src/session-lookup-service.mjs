import { displaySessionName, matchSessionName } from "./session-name-match.mjs";

function projectForCandidate(candidate) {
  if (candidate?.project?.path && candidate?.project?.alias) return candidate.project;
  if (candidate?.projectPath && candidate?.projectAlias) {
    return { alias: candidate.projectAlias, path: candidate.projectPath, authorities: candidate.authority ? [candidate.authority] : [] };
  }
  return null;
}

function candidateState(candidate) {
  if (candidate.busy || candidate.capability === "busy") return "忙碌";
  if (candidate.capability && candidate.capability !== "ready") return `不可续接(${candidate.capability})`;
  return "可续接";
}

export function formatCandidateChoices(matches) {
  const lines = [matches.length > 1 ? "找到多个可能的 Session：" : "找到一个低置信度候选，请确认："];
  matches.forEach((item, index) => {
    const candidate = item.candidate;
    const executor = candidate.executor === "claude" ? "Claude" : "Codex";
    const updated = candidate.updatedAt
      ? new Date(candidate.updatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })
      : "未知时间";
    lines.push(`${index + 1}. ${executor} | ${candidate.projectDisplay || candidate.projectAlias || "未知项目"} | ${displaySessionName(candidate.name)} | ${candidateState(candidate)} | ${updated}`);
  });
  lines.push("请使用飞书的“回复”功能回复本消息中的编号；若当前聊天只有一个有效候选列表，也可直接发送编号。");
  return lines.join("\n");
}

function projectCandidate(project) {
  return {
    kind: "project",
    identity: `project:${project.key}`,
    projectKey: project.key,
    projectPath: project.path,
    projectAlias: project.alias,
    projectDisplay: project.display,
    project,
  };
}

function formatProjectChoices(projects) {
  const lines = ["没有找到同名 Session，请选择用于新建的工程："];
  projects.forEach((project, index) => lines.push(`${index + 1}. ${project.display} | ${project.path}`));
  lines.push("请使用飞书的“回复”功能回复本消息中的编号；若当前聊天只有一个有效候选列表，也可直接发送编号。");
  return lines.join("\n");
}

export function resolveCandidateSelection(store, message) {
  const replyBinding = store.candidateSetForReply(message.reply_to);
  if (replyBinding) return { kind: "selected", binding: replyBinding };
  if (!/^(?:[1-9]|10)$/.test(String(message.content || "").trim())) return { kind: "none" };
  return store.candidateSetForStandaloneNumber({ chatId: message.chat_id, senderId: message.sender_id });
}

export function lookupFailureText(reason) {
  const messages = {
    busy: "匹配的原生 Session 正在使用中，未创建同名新会话。",
    project_unverified: "匹配到 Session，但无法验证其工程归属，未执行续接。",
    project_excluded: "匹配到 Session，但其工程位于排除目录中，未执行续接。",
    identity_conflict: "匹配到的 Session 存在身份冲突，需要先在本机处理。",
    name_claim_conflict: "该 Session 名称存在未解决的本地冲突，未执行操作。",
    name_in_use: "该 Session 名称已被其他会话使用，请重新发送以继续现有会话。",
    stale_target: "Session 状态已经变化，请重新发送会话名。",
    snapshot_incomplete: "无法完整验证 Session 状态，未执行续接或新建。",
    selection_expired: "候选列表已过期，请重新发送会话名。",
  };
  return messages[reason] || "无法安全处理该 Session，请重新查询后再试。";
}

export function createSessionLookupService({
  config,
  store,
  scheduler,
  codexRoot,
  claudeRoot,
  findNamedSession,
  revalidateNativeCandidate,
  sendGlobal,
  sendSession,
}) {
  async function queueCommitted(result) {
    if (!result?.ok || result.repeated) return result;
    scheduler.enqueue(result.task, result.session, { defer: true });
    await sendSession(result.session, "已加入执行队列。", `queued-${result.task.id}`);
    scheduler.drain();
    return result;
  }

  async function failLookup(messageId, reason, key, text = lookupFailureText(reason)) {
    store.failSessionLookup(messageId, reason);
    return sendGlobal(text, key);
  }

  async function handleNamedLookup(resolved, message, retrying = false) {
    store.beginSessionLookup({
      messageId: message.message_id,
      executor: resolved.executor,
      project: resolved.project,
      projectQuery: resolved.projectQuery,
      sessionName: resolved.name,
      content: resolved.content,
    });
    const found = await findNamedSession({
      config,
      store,
      executor: resolved.executor,
      project: resolved.project,
      projectQuery: resolved.projectQuery,
      sessionName: resolved.name,
      codexRoot,
      claudeRoot,
    });
    if (!found.complete) {
      return failLookup(message.message_id, "snapshot_incomplete", `lookup-incomplete-${message.message_id}`,
        "Session 查询不完整，未续接或新建会话，请稍后重试。");
    }
    if (resolved.projectQuery && found.projectMatch?.kind === "invalid") {
      return failLookup(message.message_id, "project_unverified", `lookup-project-query-${message.message_id}`,
        "工程名称无效，请使用简短工程名或别名，不要发送路径。");
    }
    if (resolved.projectQuery && found.projectMatch?.kind === "none") {
      return failLookup(message.message_id, "project_unverified", `lookup-project-missing-${message.message_id}`,
        "没有找到该工程，请使用已发现的工程名称。");
    }
    if (resolved.projectQuery && found.projectMatch?.kind === "selection") {
      const projects = found.projectMatch.projects.slice(0, 10);
      const set = store.createCandidateSet({ messageId: message.message_id, candidates: projects.map(projectCandidate) });
      return sendGlobal(formatProjectChoices(projects), `lookup-project-selection-${message.message_id}`, { candidateSetId: set.id });
    }
    if (found.match.kind === "invalid") {
      return failLookup(message.message_id, "invalid_name", `lookup-invalid-${message.message_id}`,
        "Session 名称过短或包含不安全字符，请换一个更明确的名称。");
    }
    if (found.match.kind === "selection") {
      const matches = found.match.matches.slice(0, 10);
      const set = store.createCandidateSet({ messageId: message.message_id, candidates: matches.map((item) => item.candidate) });
      return sendGlobal(formatCandidateChoices(matches), `lookup-selection-${message.message_id}`, { candidateSetId: set.id });
    }
    if (found.match.kind === "selected") {
      const candidate = found.match.selected;
      if (candidate.busy || candidate.capability !== "ready") {
        const reason = candidate.busy ? "busy" : candidate.capability;
        return failLookup(message.message_id, reason, `lookup-unavailable-${message.message_id}`);
      }
      if (candidate.nativeId) {
        const checked = await revalidateNativeCandidate(candidate, { config, codexRoot, claudeRoot });
        if (!checked.ok) {
          if (!retrying && checked.reason === "stale_target") return handleNamedLookup(resolved, message, true);
          return failLookup(message.message_id, checked.reason, `lookup-stale-${message.message_id}`);
        }
      }
      const project = projectForCandidate(candidate);
      if (!project) return failLookup(message.message_id, "project_unverified", `lookup-project-${message.message_id}`);
      const committed = store.commitNamedTask({
        messageId: message.message_id,
        candidate,
        executor: candidate.executor,
        project,
        name: candidate.name,
        content: resolved.content,
        action: "continue",
      });
      if (!committed.ok) return sendGlobal(lookupFailureText(committed.reason), `lookup-commit-${message.message_id}`);
      return queueCommitted(committed);
    }
    const executor = resolved.executor;
    if (retrying) return failLookup(message.message_id, "stale_target", `lookup-stale-refresh-${message.message_id}`);
    const project = found.projectMatch?.kind === "selected" ? found.projectMatch.project : resolved.project;
    if (!executor) {
      return failLookup(message.message_id, "missing_executor", `lookup-executor-${message.message_id}`,
        "没有找到同名 Session；新建前请指定 Codex 或 Claude。");
    }
    if (!project) {
      const projectSnapshot = await findNamedSession({
        config,
        store,
        executor,
        requireAllProjects: true,
        sessionName: resolved.name,
        codexRoot,
        claudeRoot,
      });
      if (!projectSnapshot.complete) return failLookup(message.message_id, "snapshot_incomplete", `lookup-project-incomplete-${message.message_id}`,
        "工程查询不完整，未新建会话，请稍后重试。");
      if (projectSnapshot.match.kind !== "none") return failLookup(message.message_id, "stale_target", `lookup-project-refresh-${message.message_id}`);
      const projects = projectSnapshot.projects.slice(0, 10);
      if (!projects.length) return failLookup(message.message_id, "missing_project", `lookup-project-${message.message_id}`,
        "没有找到同名 Session，也没有可用于新建的已发现工程。");
      const set = store.createCandidateSet({ messageId: message.message_id, candidates: projects.map(projectCandidate) });
      return sendGlobal(formatProjectChoices(projects), `lookup-project-selection-${message.message_id}`, { candidateSetId: set.id });
    }
    const committed = store.commitNamedTask({
      messageId: message.message_id,
      executor,
      project,
      name: resolved.name,
      content: resolved.content,
      action: "new",
    });
    if (!committed.ok) return sendGlobal(lookupFailureText(committed.reason), `lookup-create-${message.message_id}`);
    return queueCommitted(committed);
  }

  async function handleNewLookup(resolved, message) {
    store.beginSessionLookup({
      messageId: message.message_id,
      executor: resolved.executor,
      projectQuery: resolved.projectQuery,
      sessionName: resolved.name,
      content: resolved.content,
    });
    const found = await findNamedSession({
      config,
      store,
      executor: resolved.executor,
      projectQuery: resolved.projectQuery,
      requireAllProjects: true,
      sessionName: resolved.name,
      codexRoot,
      claudeRoot,
    });
    if (!found.complete) return failLookup(message.message_id, "snapshot_incomplete", `new-project-incomplete-${message.message_id}`,
      "工程查询不完整，未新建会话，请稍后重试。");
    if (resolved.projectQuery && found.projectMatch.kind === "invalid") {
      return failLookup(message.message_id, "project_unverified", `new-project-invalid-${message.message_id}`,
        "工程名称无效，请使用简短工程名或别名，不要发送路径。");
    }
    if (resolved.projectQuery && found.projectMatch.kind === "none") {
      return failLookup(message.message_id, "project_unverified", `new-project-missing-${message.message_id}`,
        "没有找到该工程，请使用已发现的工程名称。");
    }
    const selected = found.projectMatch.kind === "selected" ? found.projectMatch.project : null;
    if (!selected) {
      const projects = (found.projectMatch.kind === "selection" ? found.projectMatch.projects : found.projects).slice(0, 10);
      if (!projects.length) return failLookup(message.message_id, "missing_project", `new-project-empty-${message.message_id}`,
        "没有可用于新建的已发现工程。");
      const set = store.createCandidateSet({ messageId: message.message_id, candidates: projects.map(projectCandidate) });
      return sendGlobal(formatProjectChoices(projects), `new-project-selection-${message.message_id}`, { candidateSetId: set.id });
    }
    if (found.match.kind !== "none") {
      return failLookup(message.message_id, "name_in_use", `new-project-name-${message.message_id}`,
        "该工程中已有同名或近似名称的 Session，请改名或改为继续现有会话。");
    }
    const committed = store.commitNamedTask({
      messageId: message.message_id,
      executor: resolved.executor,
      project: selected,
      name: resolved.name,
      content: resolved.content,
      action: "new",
    });
    if (!committed.ok) return sendGlobal(lookupFailureText(committed.reason), `new-project-commit-${message.message_id}`);
    return queueCommitted(committed);
  }

  async function handleCandidateReply(binding, message) {
    if (!/^(?:[1-9]|10)$/.test(message.content.trim())) {
      return sendGlobal("请只回复候选列表中的编号。", `selection-invalid-${message.message_id}`);
    }
    const selectedIndex = Number(message.content.trim()) - 1;
    const candidate = binding.candidates[selectedIndex];
    if (!candidate) return sendGlobal("候选编号不存在，请重新发送会话名。", `selection-range-${message.message_id}`);
    if (binding.state !== "open" || Number(binding.expires_at) <= Date.now()) {
      return sendGlobal(lookupFailureText("selection_expired"), `selection-expired-${message.message_id}`);
    }
    if (candidate.kind === "project") {
      const refreshed = await findNamedSession({
        config,
        store,
        executor: binding.executor,
        projectQuery: null,
        requireAllProjects: true,
        sessionName: binding.session_name,
        codexRoot,
        claudeRoot,
      });
      if (!refreshed.complete) return sendGlobal(lookupFailureText("snapshot_incomplete"), `selection-project-stale-${message.message_id}`);
      const project = refreshed.projects.find((item) => item.key === candidate.projectKey);
      if (!project) return sendGlobal(lookupFailureText("stale_target"), `selection-project-missing-${message.message_id}`);
      const scopedMatch = matchSessionName(binding.session_name, refreshed.candidates
        .filter((item) => item.projectPath?.toLowerCase() === project.path.toLowerCase()));
      if (scopedMatch.kind !== "none") return sendGlobal(lookupFailureText("stale_target"), `selection-project-name-${message.message_id}`);
      if (!binding.executor) return sendGlobal("没有找到同名 Session；新建前请指定 Codex 或 Claude。", `selection-project-executor-${message.message_id}`);
      const committed = store.commitCandidateTask({
        candidateSetId: binding.id,
        selectionMessageId: message.message_id,
        selectedIndex,
        candidate,
        executor: binding.executor,
        project,
        name: binding.session_name,
        content: binding.content,
        action: "new",
      });
      if (!committed.ok) return sendGlobal(lookupFailureText(committed.reason), `selection-project-commit-${message.message_id}`);
      if (committed.repeated) return sendGlobal("该候选已经处理。", `selection-project-repeat-${message.message_id}`);
      return queueCommitted(committed);
    }
    if (candidate.busy || candidate.capability !== "ready") {
      return sendGlobal(lookupFailureText(candidate.busy ? "busy" : candidate.capability), `selection-unavailable-${message.message_id}`);
    }
    if (candidate.nativeId) {
      const checked = await revalidateNativeCandidate(candidate, { config, codexRoot, claudeRoot });
      if (!checked.ok) return sendGlobal(lookupFailureText(checked.reason), `selection-stale-${message.message_id}`);
    }
    const project = projectForCandidate(candidate);
    if (!project) return sendGlobal(lookupFailureText("project_unverified"), `selection-project-${message.message_id}`);
    const committed = store.commitCandidateTask({
      candidateSetId: binding.id,
      selectionMessageId: message.message_id,
      selectedIndex,
      candidate,
      executor: candidate.executor,
      project,
      name: candidate.name,
      content: binding.content,
    });
    if (!committed.ok) return sendGlobal(lookupFailureText(committed.reason), `selection-commit-${message.message_id}`);
    if (committed.repeated) return sendGlobal("该候选已经处理。", `selection-repeat-${message.message_id}`);
    return queueCommitted(committed);
  }

  return Object.freeze({ handleNamedLookup, handleNewLookup, handleCandidateReply, queueCommitted });
}
