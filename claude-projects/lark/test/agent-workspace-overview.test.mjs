import assert from "node:assert/strict";
import test from "node:test";
import { createAgentWorkspaceOverview } from "../src/agent-workspace-overview.mjs";

const CLAUDE_ID = "11111111-1111-4111-8111-111111111111";
const CODEX_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT = Object.freeze({
  alias: "client#12345678",
  label: "client",
  display: "client",
  aliases: Object.freeze(["client", "客户端"]),
  path: "C:\\work\\client",
  key: "c:\\work\\client",
  updatedAt: 200,
});

function candidate(overrides = {}) {
  const executor = overrides.executor || "claude";
  const nativeId = overrides.nativeId || (executor === "claude" ? CLAUDE_ID : CODEX_ID);
  return {
    provider: executor,
    executor,
    identity: `${executor}:${nativeId}`,
    gatewayId: null,
    nativeId,
    name: executor === "claude" ? "导入设置优化" : "资源检查",
    aliases: [],
    projectAlias: PROJECT.alias,
    projectDisplay: PROJECT.display,
    projectPath: PROJECT.path,
    project: PROJECT,
    authority: { sourceType: "native", provider: executor, nativeId },
    updatedAt: executor === "claude" ? 200 : 100,
    busy: false,
    capability: "ready",
    ...overrides,
  };
}

function catalog(overrides = {}) {
  return {
    candidates: [candidate(), candidate({ executor: "codex" })],
    projects: [PROJECT],
    completeness: { gateway: true, claude: true, codex: true },
    complete: true,
    ...overrides,
  };
}

function active(overrides = {}) {
  return {
    records: [{
      provider: "claude",
      agent: "claude",
      nativeId: CLAUDE_ID,
      sessionId: CLAUDE_ID,
      name: "导入设置优化",
      status: "waiting_input",
      updatedAt: 210,
    }],
    completeness: { gateway: true, claude: true, codex: true },
    warnings: [],
    additionalHidden: 0,
    ...overrides,
  };
}

function skill({ catalogResult = catalog(), activeResult = active(), onCatalog, onActive } = {}) {
  return createAgentWorkspaceOverview({
    config: { projects: [], excludedRoots: [] },
    store: {},
    buildCatalog: async (options) => { onCatalog?.(options); return catalogResult; },
    collectActive: async (options) => { onActive?.(options); return activeResult; },
  });
}

test("all overview groups Claude and Codex sessions with orthogonal counts", async () => {
  const text = await skill()({ overviewScope: "all" });
  assert.match(text, /项目 1 \| 会话 2 \| Claude Code 1 \| Codex 1/);
  assert.match(text, /活动：等待 1 .*空闲 1 .*未知 0/);
  assert.match(text, /恢复：可恢复 1 \| 占用 1 \| 不可用 0/);
  assert.match(text, /client .*Claude 1 \/ Codex 1 .*总计 2/);
});

test("project overview resolves aliases and lists metadata-only sessions", async () => {
  const text = await skill()({ overviewScope: "project", projectQuery: "客户端" });
  assert.match(text, /项目概况：client/);
  assert.match(text, /导入设置优化/);
  assert.match(text, /资源检查/);
  assert.doesNotMatch(text, /prompt|response|private/i);
});

test("exact session ID returns full metadata and privacy notice", async () => {
  const text = await skill()({ overviewScope: "session", sessionQuery: CLAUDE_ID });
  assert.match(text, /会话详情：导入设置优化/);
  assert.match(text, new RegExp(`原生 ID：${CLAUDE_ID}`));
  assert.match(text, /项目：client/);
  assert.match(text, /未读取提示词、回复或会话正文/);
});

test("incomplete relevant history makes a name match provisional", async () => {
  const incomplete = catalog({
    candidates: [candidate()],
    completeness: { gateway: true, claude: true, codex: false },
    complete: false,
  });
  const text = await skill({ catalogResult: incomplete })({
    overviewScope: "session",
    sessionQuery: "导入设置优化",
  });
  assert.match(text, /已观察会话/);
  assert.match(text, /不能判定唯一/);
  assert.doesNotMatch(text, /会话详情/);
  assert.match(text, /会话目录不完整：Codex/);
});

test("all unavailable relevant history sources return a query failure", async () => {
  const text = await skill({
    catalogResult: catalog({
      candidates: [],
      projects: [],
      completeness: { gateway: false, claude: false, codex: false },
      complete: false,
    }),
  })({ overviewScope: "all" });
  assert.match(text, /查询失败：相关会话目录均不可用/);
  assert.doesNotMatch(text, /项目 0 \| 会话 0/);
});

test("gateway identity remains visible while unverified ownership stays hidden", async () => {
  const gateway = candidate({
    provider: "gateway",
    executor: "claude",
    identity: "gateway:CL-261016-ABCDEF",
    gatewayId: "CL-261016-ABCDEF",
    nativeId: null,
    name: "Gateway Only",
    authority: { sourceType: "native", provider: "claude", nativeId: CLAUDE_ID },
    projectPath: "C:\\secret\\stored-path",
    projectDisplay: "stored",
  });
  const text = await skill({ catalogResult: catalog({ candidates: [gateway] }), activeResult: active({ records: [] }) })({
    overviewScope: "session",
    sessionQuery: gateway.gatewayId,
  });
  assert.match(text, /会话详情：Gateway Only/);
  assert.match(text, /项目：归属不可用/);
  assert.doesNotMatch(text, /secret|stored-path/i);
  assert.match(text, /恢复：不可用/);
});

test("failed activity evidence reports unknown instead of idle", async () => {
  const text = await skill({
    catalogResult: catalog({ candidates: [candidate()] }),
    activeResult: active({ records: [], completeness: { gateway: true, claude: false, codex: true } }),
  })({ overviewScope: "all", overviewExecutor: "claude" });
  assert.match(text, /空闲 0 \| 未知 1/);
  assert.match(text, /可恢复 0 \| 占用 0 \| 不可用 1/);
});

test("executor filter limits collection and completeness warnings", async () => {
  let requestedExecutor = null;
  let activeExecutor = null;
  const text = await skill({
    catalogResult: catalog({
      candidates: [candidate()],
      completeness: { gateway: true, claude: true, codex: false },
      complete: true,
    }),
    activeResult: active({ completeness: { gateway: true, claude: true, codex: false } }),
    onCatalog: (options) => { requestedExecutor = options.executor; },
    onActive: (options) => { activeExecutor = options.executor; },
  })({ overviewScope: "all", overviewExecutor: "claude" });
  assert.equal(requestedExecutor, "claude");
  assert.equal(activeExecutor, "claude");
  assert.doesNotMatch(text, /会话目录不完整/);
  assert.doesNotMatch(text, /活动状态不完整/);
});

test("records beyond the first 200 remain counted and exactly queryable", async () => {
  const candidates = [];
  const projects = [];
  for (let index = 0; index < 201; index += 1) {
    const suffix = String(index).padStart(12, "0");
    const nativeId = `33333333-3333-4333-8333-${suffix}`;
    const project = {
      ...PROJECT,
      alias: `project-${index}`,
      label: `project-${index}`,
      display: `project-${index}`,
      aliases: [`project-${index}`],
      path: `C:\\work\\project-${index}`,
      key: `c:\\work\\project-${index}`,
    };
    projects.push(project);
    candidates.push(candidate({ nativeId, name: `session-${index}`, project, projectAlias: project.alias, projectDisplay: project.display, projectPath: project.path }));
  }
  const catalogResult = catalog({ candidates, projects });
  const overview = skill({ catalogResult, activeResult: active({ records: [] }) });
  const all = await overview({ overviewScope: "all", overviewExecutor: "claude" });
  assert.match(all, /项目 201 \| 会话 201/);
  assert.match(all, /另有 171 个项目未显示/);
  const exact = await overview({ overviewScope: "session", overviewExecutor: "claude", sessionQuery: candidates[200].nativeId });
  assert.match(exact, /会话详情：session-200/);
});
