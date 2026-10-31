const definitions = Object.freeze([
  Object.freeze({
    name: "off_work",
    description: "SessionMgr 下班：独立文字命令‘下班’关闭已识别 Agent 客户端；‘下班检查’只读预览",
  }),
  Object.freeze({
    name: "list_agent_sessions",
    description: "逐条列出本机全部项目的 Claude Code 或 Codex 历史会话，自动分批返回完整列表",
  }),
  Object.freeze({
    name: "list_active_agent_sessions",
    description: "查询当前 PC 上正在工作的 Codex、Claude Code 和网关 Session",
  }),
  Object.freeze({
    name: "inspect_agent_workspace",
    description: "只读查询本机 Claude Code 和 Codex 的全部、单项目或单 Session 元数据概况",
  }),
  Object.freeze({
    name: "stop_agent_session",
    description: "使用查询结果中的停止ID精确停止一个正在工作的 Agent Session",
  }),
  Object.freeze({
    name: "ccswitch",
    description: "只读查询本机 CC Switch 的概况、Provider、健康状态、路由状态和用量",
  }),
]);

export function createInternalSkillRegistry(handlers = {}) {
  const registered = new Map(definitions.map((definition) => [definition.name, {
    ...definition,
    handler: handlers[definition.name],
  }]));

  return Object.freeze({
    descriptors() {
      return definitions.map(({ name, description }) => ({ name, description }));
    },
    has(name) {
      return typeof name === "string" && registered.has(name);
    },
    async dispatch(name, input) {
      const entry = registered.get(name);
      if (!entry || typeof entry.handler !== "function") throw new Error(`内部技能不可用：${name}`);
      return entry.handler(input);
    },
  });
}
