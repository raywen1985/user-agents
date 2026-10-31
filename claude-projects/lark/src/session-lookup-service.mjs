import { displaySessionName, matchSessionName } from "./session-name-match.mjs";
import { candidateFailure, logLookupFailure, retrySnapshot } from "./lookup-observation.mjs";

function projectForCandidate(candidate) {
  if (candidate?.project?.path && candidate?.project?.alias) return candidate.project;
  if (candidate?.projectPath && candidate?.projectAlias) {
    return { alias: candidate.projectAlias, path: candidate.projectPath, authorities: candidate.authority ? [candidate.authority] : [] };
  }
  return null;
}

function candidateState(candidate) {
  if (candidate.capability === "archived") return "已归档（需先取消归档）";
  if (candidate.capability === "native_missing") return "原生记录已不存在";
  if (candidate.busy || candidate.capability === "busy") return "忙碌";
  if (candidate.capability && candidate.capability !== "ready") return `不可续接(${candidate.capability})`;
  return "可续接";
}

function existingSessionCandidate(candidate, score = null) {
  return {
    kind: "existing-session",
    identity: `session:${candidate.identity}`,
    candidate,
    score,
  };
}

function createNewCandidate() {
  return { kind: "create-new", identity: "action:create-new" };
}

export function formatCandidateChoices(items, { exact = false, recent = false } = {}) {
  const heading = exact ? "找到多个同名 Session，请选择："
    : recent ? "未指定 Session，请选择最近 Session 或新建："
      : "没有找到同名 Session，请选择相似 Session 或新建：";
  const lines = [heading];
  items.forEach((item, index) => {
    if (item.kind === "create-new") {
      lines.push(`${index + 1}. 在新 Session 中执行`);
      return;
    }
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

const projectPathOrder = new Intl.Collator("zh-CN", { sensitivity: "base", numeric: true });
function projectChoices(projects, details = {}) {
  return [...projects]
    .sort((left, right) => projectPathOrder.compare(left.path.replaceAll("/", "\\"), right.path.replaceAll("/", "\\")))
    .map((project) => ({ ...projectCandidate(project), ...details }));
}

function executorCandidate(executor) {
  return {
    kind: "executor",
    identity: `executor:${executor}`,
    executor,
  };
}

function formatExecutorChoices(items) {
  const lines = ["请选择新 Session 的执行器："];
  items.forEach((item, index) => lines.push(`${index + 1}. ${item.executor === "claude" ? "Claude" : "Codex"}`));
  lines.push("请使用飞书的“回复”功能回复本消息中的编号；若当前聊天只有一个有效候选列表，也可直接发送编号。");
  return lines.join("\n");
}

function formatProjectChoices(projects) {
  const lines = ["请选择新 Session 所属工程："];
  projects.forEach((project, index) => lines.push(`${index + 1}. ${project.display} | ${project.path}`));
  lines.push("请使用飞书的“回复”功能回复本消息中的编号；若当前聊天只有一个有效候选列表，也可直接发送编号。");
  return lines.join("\n");
}

export function resolveCandidateSelection(store, message) {
  const replyBinding = store.candidateSetForReply(message.reply_to);
  if (replyBinding) return { kind: "selected", binding: replyBinding };
  if (!/^(?:(?:[1-9]|10)|上一页|下一页)$/.test(String(message.content || "").trim())) return { kind: "none" };
  return store.candidateSetForStandaloneNumber({ chatId: message.chat_id, senderId: message.sender_id });
}

function generatedSessionName(content) {
  const compact = String(content || "").trim().replace(/\s+/gu, "-")
    .replace(/[^\p{L}\p{N}_-]+/gu, "").replace(/^-+|-+$/gu, "");
  return (compact || "新任务").slice(0, 24);
}

export function lookupFailureText(reason) {
  const messages = {
    archived: "该 Codex Session 已归档，请先在本机取消归档（codex unarchive）后重试，未加入执行队列。",
    native_missing: "该 Session 只剩 Gateway 记录，原生历史已不存在，无法续接。请指定其他会话或明确新建。",
    busy: "匹配的原生 Session 正在使用中，未创建同名新会话。",
    off_work: "该请求被下班操作拦截，请在下班完成后重新发送任务。",
    project_unverified: "匹配到 Session，但无法验证其工程归属，未执行续接。",
    project_excluded: "匹配到 Session，但其工程位于排除目录中，未执行续接。",
    identity_conflict: "匹配到的 Session 存在身份冲突，需要先在本机处理。",
    name_claim_conflict: "该 Session 名称存在未解决的本地冲突，未执行操作。",
    name_in_use: "该 Session 名称已被其他会话使用，请重新发送以继续现有会话。",
    stale_target: "Session 状态已经变化，请重新发送会话名。",
    snapshot_incomplete: "暂时无法完整验证 Session 状态，已重试一次；未执行续接或新建，请稍后重试。",
    selection_expired: "候选列表已过期，请重新发送会话名。",
    selection_superseded: "此候选列表已被同一聊天中的新请求替代，请回复最新候选消息。",
  };
  return messages[reason] || "无法安全处理该 Session，请重新查询后再试。";
}

export function createSessionLookupService({
  config,
  store,
  scheduler,
  codexRoot,
  claudeRoot,
  findNamedSession: readNamedSession,
  revalidateNativeCandidate: readNativeCandidate,
  sendGlobal,
  sendSession,
}) {
  const findNamedSession = options => retrySnapshot(() => readNamedSession(options));
  const revalidateNativeCandidate = (candidate, options) => retrySnapshot(() => readNativeCandidate(candidate, options));
  const failureReply = (messageId, reason, key, text = lookupFailureText(reason), executor = null) => {
    logLookupFailure({ messageId, reason, executor: executor || store.getSessionLookup?.(messageId)?.executor });
    return sendGlobal(text, `${key}-${reason}`);
  };
  function firstPage(candidates, kind) {
    if (kind === "session-choice" && candidates.at(-1)?.kind === "create-new") {
      return [...candidates.slice(0, -1).slice(0, 9), candidates.at(-1)];
    }
    return candidates.slice(0, 10);
  }

  async function createCandidatePrompt({ messageId, candidates, kind, text, key }) {
    const set = store.createCandidateSet({
      messageId,
      candidates,
      kind,
      outbox: { dedupeKey: key, text: `[Gateway | - | - | -]\n${text}` },
    });
    await sendGlobal(text, key, {
      prequeued: true,
      candidateSetId: set.id,
      candidatePageId: set.page?.id,
    });
    return set;
  }

  async function refreshSessionCandidates(binding, message, selectedIndex, selectedCandidate) {
    const refreshed = await findNamedSession({
      config,
      store,
      executor: binding.executor,
      requireAllProjects: true,
      sessionName: binding.session_name,
      codexRoot,
      claudeRoot,
    });
    if (!refreshed.complete) {
      return failureReply(message.message_id, "snapshot_incomplete", `selection-refresh-incomplete-${message.message_id}`);
    }
    let exact = false;
    let items;
    if (refreshed.match.kind === "selected") {
      exact = true;
      items = [existingSessionCandidate(refreshed.match.selected)];
    } else if (refreshed.match.kind === "selection") {
      exact = Boolean(refreshed.match.exact);
      items = refreshed.match.matches.map((item) => existingSessionCandidate(item.candidate, item.score));
      if (!exact) items.push(createNewCandidate());
    } else {
      items = [createNewCandidate()];
    }
    const key = `selection-refresh-${binding.id}`;
    const text = formatCandidateChoices(firstPage(items, "session-choice"), { exact });
    const replaced = store.replaceCandidateSet({
      replacedSetId: binding.id,
      candidatePageId: binding.page_id,
      selectedIndex,
      candidate: selectedCandidate,
      candidates: items,
      kind: "session-choice",
      outbox: { dedupeKey: key, text: `[Gateway | - | - | -]\n${text}` },
    });
    if (!replaced.ok) return failureReply(message.message_id, replaced.reason, `selection-refresh-failed-${message.message_id}`);
    return sendGlobal(text, key, {
      prequeued: true,
      candidateSetId: replaced.set.id,
      candidatePageId: replaced.set.page?.id,
    });
  }

  function hasExactSession(found) {
    return found.match.kind === "selected" || (found.match.kind === "selection" && found.match.exact);
  }

  async function creationSnapshot(executor, baseName, autoName) {
    for (let suffix = 1; suffix <= 100; suffix += 1) {
      const name = suffix === 1 ? baseName : `${baseName}-${suffix}`;
      const found = await findNamedSession({
        config,
        store,
        executor,
        requireAllProjects: true,
        sessionName: name,
        codexRoot,
        claudeRoot,
      });
      if (!found.complete) return { ok: false, reason: "snapshot_incomplete" };
      if (!hasExactSession(found)) return { ok: true, name, found };
      if (!autoName) return { ok: false, reason: "name_in_use" };
    }
    return { ok: false, reason: "name_in_use" };
  }

  async function queueCommitted(result) {
    if (!result?.ok || result.repeated) return result;
    if (scheduler.reconcileQueuedTasks) scheduler.reconcileQueuedTasks({ drain: false });
    else scheduler.enqueue(result.task, result.session, { defer: true });
    await sendSession(result.session, "已加入执行队列。", `queued-${result.task.id}`);
    scheduler.drain();
    return result;
  }

  async function failLookup(messageId, reason, key, text = lookupFailureText(reason)) {
    store.failSessionLookup(messageId, reason);
    return failureReply(messageId, reason, key, text);
  }

  async function handleNamedLookup(resolved, message, retrying = false) {
    const creationProject = resolved.creationProject || resolved.project || null;
    store.beginSessionLookup({
      messageId: message.message_id,
      executor: resolved.executor,
      project: creationProject,
      projectQuery: resolved.projectQuery,
      sessionName: resolved.name,
      content: resolved.content,
      approvalProfile: resolved.approvalProfile,
    });
    const found = await findNamedSession({
      config,
      store,
      executor: resolved.executor,
      project: null,
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
      const projects = found.projectMatch.projects;
      const candidates = projectChoices(projects);
      const key = `lookup-project-selection-${message.message_id}`;
      return createCandidatePrompt({
        messageId: message.message_id, candidates, kind: "project-choice", key,
        text: formatProjectChoices(firstPage(candidates, "project-choice").map((item) => item.project)),
      });
    }
    if (found.match.kind === "invalid") {
      return failLookup(message.message_id, "invalid_name", `lookup-invalid-${message.message_id}`,
        "Session 名称过短或包含不安全字符，请换一个更明确的名称。");
    }
    if (found.match.kind === "selection") {
      const exact = Boolean(found.match.exact);
      const items = found.match.matches
        .map((item) => existingSessionCandidate(item.candidate, item.score));
      if (!exact) items.push(createNewCandidate());
      const key = `lookup-selection-${message.message_id}`;
      return createCandidatePrompt({
        messageId: message.message_id, candidates: items, kind: "session-choice", key,
        text: formatCandidateChoices(firstPage(items, "session-choice"), { exact }),
      });
    }
    if (found.match.kind === "selected") {
      const candidate = found.match.selected;
      if (candidate.busy || candidate.capability !== "ready") {
        const reason = candidateFailure(candidate);
        return failLookup(message.message_id, reason, `lookup-unavailable-${message.message_id}`);
      }
      if (candidate.nativeId) {
        const checked = await revalidateNativeCandidate(candidate, { config, codexRoot, claudeRoot });
        if (!checked.ok) {
          if (!retrying && checked.reason === "stale_target") return handleNamedLookup(resolved, message, true);
          return failLookup(message.message_id, checked.reason, `lookup-${checked.reason}-${message.message_id}`);
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
        approvalProfile: resolved.approvalProfile,
      });
      if (!committed.ok) return failureReply(message.message_id, committed.reason, `lookup-commit-${message.message_id}`);
      return queueCommitted(committed);
    }
    const items = [createNewCandidate()];
    const key = `lookup-create-choice-${message.message_id}`;
    return createCandidatePrompt({
      messageId: message.message_id, candidates: items, kind: "session-choice", key,
      text: formatCandidateChoices(firstPage(items, "session-choice")),
    });
  }

  async function handleUnnamedContinue(resolved, message) {
    const name = generatedSessionName(resolved.content);
    store.beginSessionLookup({
      messageId: message.message_id,
      executor: resolved.executor || null,
      sessionName: name,
      content: resolved.content,
      autoName: true,
      approvalProfile: resolved.approvalProfile,
    });
    const found = await findNamedSession({
      config,
      store,
      executor: resolved.executor || null,
      requireAllProjects: true,
      sessionName: name,
      codexRoot,
      claudeRoot,
    });
    if (!found.complete) return failLookup(message.message_id, "snapshot_incomplete", `recent-incomplete-${message.message_id}`);
    const recent = [...found.candidates]
      .filter((candidate) => !resolved.executor || candidate.executor === resolved.executor)
      .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))
      .slice(0, 199)
      .map((candidate) => existingSessionCandidate(candidate));
    const items = [...recent, createNewCandidate()];
    const key = `recent-selection-${message.message_id}`;
    return createCandidatePrompt({
      messageId: message.message_id, candidates: items, kind: "session-choice", key,
      text: formatCandidateChoices(firstPage(items, "session-choice"), { recent: true }),
    });
  }

  async function handleNewLookup(resolved, message) {
    store.beginSessionLookup({
      messageId: message.message_id,
      executor: resolved.executor,
      projectQuery: resolved.projectQuery,
      sessionName: resolved.name,
      content: resolved.content,
      approvalProfile: resolved.approvalProfile,
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
    const selected = resolved.project || (found.projectMatch.kind === "selected" ? found.projectMatch.project : null);
    if (!selected) {
      const projects = found.projectMatch.kind === "selection" ? found.projectMatch.projects : found.projects;
      if (!projects.length) return failLookup(message.message_id, "missing_project", `new-project-empty-${message.message_id}`,
        "没有可用于新建的已发现工程。");
      const candidates = projectChoices(projects);
      const key = `new-project-selection-${message.message_id}`;
      return createCandidatePrompt({
        messageId: message.message_id, candidates, kind: "project-choice", key,
        text: formatProjectChoices(firstPage(candidates, "project-choice").map((item) => item.project)),
      });
    }
    if (found.match.kind === "selected" || (found.match.kind === "selection" && found.match.exact)) {
      return failLookup(message.message_id, "name_in_use", `new-project-name-${message.message_id}`,
        "已经存在同名 Session，请使用不同名称，或改为继续现有会话。");
    }
    const committed = store.commitNamedTask({
      messageId: message.message_id,
      executor: resolved.executor,
      project: selected,
      name: resolved.name,
      content: resolved.content,
      action: "new",
      approvalProfile: resolved.approvalProfile,
    });
    if (!committed.ok) return failureReply(message.message_id, committed.reason, `new-project-commit-${message.message_id}`);
    return queueCommitted(committed);
  }

  async function handleCandidateReply(binding, message) {
    if (!/^(?:[1-9]|10)$/.test(message.content.trim())) {
      return sendGlobal("请只回复候选列表中的编号。", `selection-invalid-${message.message_id}`);
    }
    if (binding.state === "superseded") {
      return failureReply(message.message_id, "selection_superseded", `selection-superseded-${message.message_id}`);
    }
    if (!["open", "transitioned", "consumed"].includes(binding.state) || Number(binding.expires_at) <= Date.now()) {
      return failureReply(message.message_id, "selection_expired", `selection-expired-${message.message_id}`);
    }
    const selectedIndex = Number(message.content.trim()) - 1;
    const candidate = binding.candidates[selectedIndex];
    if (!candidate) return sendGlobal("候选编号不存在，请重新发送会话名。", `selection-range-${message.message_id}`);
    if (candidate.kind === "create-new") {
      if (!binding.executor) {
        const executors = [executorCandidate("codex"), executorCandidate("claude")];
        const key = `selection-executors-${binding.request_message_id}`;
        const text = formatExecutorChoices(executors);
        const transitioned = store.transitionCandidateSet({
          parentSetId: binding.id,
          candidatePageId: binding.page_id,
          selectionMessageId: message.message_id,
          selectedIndex,
          candidate,
          kind: "executor-choice",
          candidates: executors,
          outbox: { dedupeKey: key, text: `[Gateway | - | - | -]\n${text}` },
        });
        if (!transitioned.ok) return failureReply(message.message_id, transitioned.reason, `selection-executor-transition-${message.message_id}`);
        return sendGlobal(text, key, {
          prequeued: true, candidateSetId: transitioned.set.id, candidatePageId: transitioned.set.page?.id,
        });
      }
      const creation = await creationSnapshot(binding.executor, binding.session_name, Boolean(binding.auto_name));
      if (!creation.ok && creation.reason === "snapshot_incomplete") {
        return failureReply(message.message_id, creation.reason, `selection-new-incomplete-${message.message_id}`);
      }
      if (!creation.ok) {
        return sendGlobal("已经出现同名 Session，请重新发送原命令以选择该会话。", `selection-new-name-${message.message_id}`);
      }
      const refreshed = creation.found;
      const creationName = creation.name;
      const projects = refreshed.projects;
      if (!projects.length) return sendGlobal("没有可用于新建的已发现工程。", `selection-new-project-empty-${message.message_id}`);
      const selectedProject = binding.project_path
        ? projects.find((item) => item.path.toLowerCase() === binding.project_path.toLowerCase())
        : null;
      if (selectedProject) {
        const committed = store.commitCandidateTask({
          candidateSetId: binding.id,
          candidatePageId: binding.page_id,
          selectionMessageId: message.message_id,
          selectedIndex,
          candidate,
          executor: binding.executor,
          project: selectedProject,
          name: creationName,
          content: binding.content,
          action: "new",
        });
        if (!committed.ok) return failureReply(message.message_id, committed.reason, `selection-new-commit-${message.message_id}`);
        return queueCommitted(committed);
      }
      const projectItems = projectChoices(projects, { executor: binding.executor, name: creationName });
      const key = `selection-new-projects-${binding.request_message_id}`;
      const text = formatProjectChoices(firstPage(projectItems, "project-choice").map((item) => item.project));
      const transitioned = store.transitionCandidateSet({
        parentSetId: binding.id,
        candidatePageId: binding.page_id,
        selectionMessageId: message.message_id,
        selectedIndex,
        candidate,
        kind: "project-choice",
        candidates: projectItems,
        outbox: { dedupeKey: key, text: `[Gateway | - | - | -]\n${text}` },
      });
      if (!transitioned.ok) return failureReply(message.message_id, transitioned.reason, `selection-new-transition-${message.message_id}`);
      return sendGlobal(text, key, {
        prequeued: true, candidateSetId: transitioned.set.id, candidatePageId: transitioned.set.page?.id,
      });
    }
    if (candidate.kind === "executor") {
      const creation = await creationSnapshot(candidate.executor, binding.session_name, Boolean(binding.auto_name));
      if (!creation.ok && creation.reason === "snapshot_incomplete") {
        return failureReply(message.message_id, creation.reason, `selection-executor-incomplete-${message.message_id}`);
      }
      if (!creation.ok) {
        return sendGlobal("已经存在同名 Session，请重新发送原命令以选择该会话。", `selection-executor-name-${message.message_id}`);
      }
      const refreshed = creation.found;
      const projectItems = projectChoices(refreshed.projects, { executor: candidate.executor, name: creation.name });
      if (!projectItems.length) return sendGlobal("没有可用于新建的已发现工程。", `selection-executor-project-empty-${message.message_id}`);
      const key = `selection-executor-projects-${binding.request_message_id}`;
      const text = formatProjectChoices(firstPage(projectItems, "project-choice").map((item) => item.project));
      const transitioned = store.transitionCandidateSet({
        parentSetId: binding.id,
        candidatePageId: binding.page_id,
        selectionMessageId: message.message_id,
        selectedIndex,
        candidate,
        kind: "project-choice",
        candidates: projectItems,
        outbox: { dedupeKey: key, text: `[Gateway | - | - | -]\n${text}` },
      });
      if (!transitioned.ok) return failureReply(message.message_id, transitioned.reason, `selection-executor-project-${message.message_id}`);
      return sendGlobal(text, key, {
        prequeued: true, candidateSetId: transitioned.set.id, candidatePageId: transitioned.set.page?.id,
      });
    }
    if (candidate.kind === "project") {
      const executor = candidate.executor || binding.executor;
      const targetName = candidate.name || binding.session_name;
      const refreshed = await findNamedSession({
        config,
        store,
        executor,
        projectQuery: null,
        requireAllProjects: true,
        sessionName: targetName,
        codexRoot,
        claudeRoot,
      });
      if (!refreshed.complete) return failureReply(message.message_id, "snapshot_incomplete", `selection-project-stale-${message.message_id}`);
      const project = refreshed.projects.find((item) => item.key === candidate.projectKey);
      if (!project) return failureReply(message.message_id, "stale_target", `selection-project-missing-${message.message_id}`);
      const scopedMatch = matchSessionName(targetName, refreshed.candidates
        .filter((item) => item.projectPath?.toLowerCase() === project.path.toLowerCase()));
      if (scopedMatch.kind === "selected" || (scopedMatch.kind === "selection" && scopedMatch.exact)) {
        return failureReply(message.message_id, "stale_target", `selection-project-name-${message.message_id}`);
      }
      if (!executor) return sendGlobal("没有找到同名 Session；新建前请指定 Codex 或 Claude。", `selection-project-executor-${message.message_id}`);
      const committed = store.commitCandidateTask({
        candidateSetId: binding.id,
        candidatePageId: binding.page_id,
        selectionMessageId: message.message_id,
        selectedIndex,
        candidate,
        executor,
        project,
        name: candidate.name || binding.session_name,
        content: binding.content,
        action: "new",
      });
      if (!committed.ok) return failureReply(message.message_id, committed.reason, `selection-project-commit-${message.message_id}`);
      if (committed.repeated) return sendGlobal("该候选已经处理。", `selection-project-repeat-${message.message_id}`);
      return queueCommitted(committed);
    }
    if (candidate.kind !== "existing-session" || !candidate.candidate) {
      return sendGlobal("候选类型无效，请重新发送原命令。", `selection-kind-${message.message_id}`);
    }
    const sessionCandidate = candidate.candidate;
    if (sessionCandidate.busy || sessionCandidate.capability !== "ready") {
      return failureReply(message.message_id, candidateFailure(sessionCandidate), `selection-unavailable-${message.message_id}`, undefined, sessionCandidate.executor);
    }
    if (sessionCandidate.nativeId) {
      const checked = await revalidateNativeCandidate(sessionCandidate, { config, codexRoot, claudeRoot });
      if (!checked.ok) {
        if (checked.reason === "stale_target") {
          return refreshSessionCandidates(binding, message, selectedIndex, candidate);
        }
        return failureReply(message.message_id, checked.reason, `selection-${checked.reason}-${message.message_id}`, undefined, sessionCandidate.executor);
      }
    }
    const project = projectForCandidate(sessionCandidate);
    if (!project) return failureReply(message.message_id, "project_unverified", `selection-project-${message.message_id}`);
    const committed = store.commitCandidateTask({
      candidateSetId: binding.id,
      candidatePageId: binding.page_id,
      selectionMessageId: message.message_id,
      selectedIndex,
      candidate,
      executor: sessionCandidate.executor,
      project,
      name: sessionCandidate.name,
      content: binding.content,
    });
    if (!committed.ok) return failureReply(message.message_id, committed.reason, `selection-commit-${message.message_id}`);
    if (committed.repeated) return sendGlobal("该候选已经处理。", `selection-repeat-${message.message_id}`);
    return queueCommitted(committed);
  }

  async function handleCandidateNavigation(binding, message, direction) {
    const moved = store.navigateCandidatePage({
      candidateSetId: binding.id,
      direction,
      renderOutbox: (set) => {
        const text = set.kind === "project-choice"
          ? formatProjectChoices(set.candidates.map((item) => item.project))
          : set.kind === "executor-choice"
            ? formatExecutorChoices(set.candidates)
            : formatCandidateChoices(set.candidates);
        return {
          dedupeKey: `selection-page-${set.id}-${set.page.page_number}`,
          text: `[Gateway | - | - | -]\n${text}`,
          displayText: text,
        };
      },
    });
    if (!moved.ok) {
      const text = moved.reason === "page_range" ? "已经是候选列表的第一页或最后一页。" : lookupFailureText(moved.reason);
      return sendGlobal(text, `selection-page-${message.message_id}`);
    }
    const set = moved.set;
    return sendGlobal(moved.outbox.displayText, `selection-page-${set.id}-${set.page.page_number}`, {
      prequeued: true, candidateSetId: set.id, candidatePageId: set.page.id,
    });
  }

  return Object.freeze({
    handleNamedLookup,
    handleNewLookup,
    handleUnnamedContinue,
    handleCandidateReply,
    handleCandidateNavigation,
    queueCommitted,
  });
}
