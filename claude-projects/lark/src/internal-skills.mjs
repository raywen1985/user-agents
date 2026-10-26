const definitions = Object.freeze([
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
