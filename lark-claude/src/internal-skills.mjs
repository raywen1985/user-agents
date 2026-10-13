const definitions = Object.freeze([
  Object.freeze({
    name: "list_active_agent_sessions",
    description: "查询当前 PC 上正在工作的 Codex、Claude Code 和网关 Session",
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
