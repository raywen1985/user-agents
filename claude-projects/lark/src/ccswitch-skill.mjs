import { CcSwitchReadError } from "./ccswitch-reader.mjs";

const MAX_BODY_BYTES = 12288;
const ERROR_TEXT = Object.freeze({
  not_installed: "未检测到 CC Switch 数据库。",
  schema_incompatible: "当前 CC Switch 数据结构与只读技能不兼容。",
  data_invalid: "CC Switch 中存在无法安全读取的数据。",
  read_busy: "CC Switch 数据库正忙，请稍后重试。",
  read_timeout: "CC Switch 查询超时，请稍后重试。",
  read_unavailable: "当前无法取得安全的 CC Switch 只读快照。",
  resource_limit: "CC Switch 数据超过只读查询的安全上限。",
  read_failed: "CC Switch 查询失败。",
});

function onOff(value) {
  return value === true ? "开启" : value === false ? "关闭" : "不可用";
}

function yesNo(value) {
  return value ? "是" : "否";
}

function appendBounded(lines, records, omitted = 0) {
  let hidden = omitted;
  for (const record of records) {
    const candidate = [...lines, record];
    if (Buffer.byteLength(candidate.join("\n"), "utf8") > MAX_BODY_BYTES - 64) {
      hidden += 1;
      continue;
    }
    lines.push(record);
  }
  if (hidden) lines.push(`... 另有 ${hidden} 条未显示`);
  if (Buffer.byteLength(lines.join("\n"), "utf8") > MAX_BODY_BYTES) {
    while (lines.length > 1 && Buffer.byteLength([...lines.slice(0, -1), "... 输出达到上限"].join("\n"), "utf8") > MAX_BODY_BYTES) lines.pop();
    lines.push("... 输出达到上限");
  }
  return lines.join("\n");
}

function formatOverview(result) {
  const lines = [
    "CC Switch 概况",
    `安装状态：${result.installed ? "已安装" : "未安装"}`,
    `应用版本：${result.applicationVersion || "不可用"}`,
    `数据库 Schema：${result.databaseSchemaVersion}`,
    `数据库更新时间：${result.databaseLastWriteAt}`,
    `最新明细：${result.latestDetail.value || result.latestDetail.state}`,
    `最新日汇总：${result.latestRollup.value || result.latestRollup.state}`,
    "应用：",
  ];
  const records = result.rows.map((row) => `- ${row.appLabel} | 当前 Provider: ${row.currentProvider || "未设置"} | 启用: ${onOff(row.enabled)} | 代理: ${onOff(row.proxyEnabled)}`);
  if (!records.length) records.push("- 暂无应用数据");
  return appendBounded(lines, records, result.omitted);
}

function formatProviders(result) {
  const lines = ["CC Switch Provider"];
  const records = result.rows.map((row) => {
    const parts = [`- ${row.appLabel} | ${row.name}`, row.current ? "当前" : "非当前"];
    if (row.category) parts.push(`分类: ${row.category}`);
    if (row.providerType) parts.push(`类型: ${row.providerType}`);
    if (row.endpointOrigin) parts.push(`地址: ${row.endpointOrigin}`);
    return parts.join(" | ");
  });
  if (!records.length) records.push("暂无 Provider 数据。");
  return appendBounded(lines, records, result.omitted);
}

function formatHealth(result) {
  const labels = { healthy: "健康", unhealthy: "异常", unknown: "未知" };
  const lines = ["CC Switch Provider 健康状态"];
  const records = result.rows.map((row) => {
    const parts = [`- ${row.appLabel} | ${row.providerName} | ${labels[row.state] || "未知"}`];
    if (row.stale) parts.push("数据已陈旧");
    if (row.consecutiveFailures !== null) parts.push(`连续失败: ${row.consecutiveFailures}`);
    if (row.updatedAt) parts.push(`更新: ${row.updatedAt}`);
    return parts.join(" | ");
  });
  if (!records.length) records.push("暂无健康状态数据。");
  return appendBounded(lines, records, result.omitted);
}

function formatRouting(result) {
  const lines = ["CC Switch 本地路由状态"];
  const records = result.rows.map((row) => [
    `- ${row.appLabel}`,
    `总开关: ${onOff(row.enabled)}`,
    `代理: ${onOff(row.proxyEnabled)}`,
    `监听: ${row.listenClass}:${row.listenPort}`,
    `日志: ${onOff(row.loggingEnabled)}`,
    `故障转移: ${onOff(row.failoverEnabled)}`,
    `接管: ${onOff(row.liveTakeoverActive)}`,
    `更新: ${row.updatedAt}`,
  ].join(" | "));
  if (!records.length) records.push("暂无路由配置数据。");
  return appendBounded(lines, records, result.omitted);
}

function formatInputTokens(values) {
  const entries = Object.entries(values);
  return entries.length ? entries.map(([semantics, count]) => `口径${semantics}=${count}`).join(", ") : "无";
}

function metricLine(metric) {
  const rate = metric.successRate === null ? "不可用" : `${metric.successRate.toFixed(2)}%`;
  const latency = metric.averageLatencyMs === null ? "不可用" : `${metric.averageLatencyMs}ms${metric.latencyEstimated ? "（估算）" : ""}`;
  return `请求 ${metric.requests} | 成功率 ${rate} | 输入 ${formatInputTokens(metric.inputTokensBySemantics)} | 输出 ${metric.outputTokens} | Cache读 ${metric.cacheReadTokens} | Cache写 ${metric.cacheCreationTokens} | 费用 $${metric.estimatedCostUsd} | 平均延迟 ${latency}`;
}

function formatUsage(result) {
  const periodLabels = { today: "今天", yesterday: "昨天", last_7_days: "最近7天", last_30_days: "最近30天" };
  const lines = [
    `CC Switch 用量（${periodLabels[result.period]}）`,
    `覆盖：仅已观察数据${result.potentiallyIncomplete ? "，可能不完整" : ""}`,
  ];
  if (!result.totals.requests) lines.push("未观察到用量数据。");
  else lines.push(`总计：${metricLine(result.totals)}`);
  for (const [key, title] of [["app", "按应用"], ["provider", "按 Provider"], ["model", "按模型"]]) {
    const section = result.breakdowns[key];
    lines.push(`${title}：`);
    const records = section.rows.map((row) => `- ${row.label} | ${metricLine(row)}`);
    if (!records.length) records.push("- 无");
    const rendered = appendBounded([], records, section.omitted).split("\n");
    for (const line of rendered) {
      if (Buffer.byteLength([...lines, line].join("\n"), "utf8") > MAX_BODY_BYTES - 32) {
        lines.push("... 输出达到上限");
        return lines.join("\n");
      }
      lines.push(line);
    }
  }
  return lines.join("\n");
}

export function formatCcSwitchResult(result) {
  if (result.action === "overview") return formatOverview(result);
  if (result.action === "providers") return formatProviders(result);
  if (result.action === "health") return formatHealth(result);
  if (result.action === "routing_status") return formatRouting(result);
  if (result.action === "usage") return formatUsage(result);
  throw new CcSwitchReadError("data_invalid");
}

function elapsedBucket(elapsed) {
  if (elapsed < 100) return "lt_100ms";
  if (elapsed < 500) return "lt_500ms";
  if (elapsed < 1000) return "lt_1s";
  if (elapsed < 3000) return "lt_3s";
  return "gte_3s";
}

function rowBucket(result) {
  const count = Array.isArray(result?.rows) ? result.rows.length : result?.totals?.requests || 0;
  if (!count) return "0";
  if (count <= 10) return "1_10";
  if (count <= 50) return "11_50";
  return "gt_50";
}

export function createCcSwitchSkill({ reader, onDiagnostic = () => {}, now = Date.now }) {
  return async ({ ccswitchAction, usagePeriod }) => {
    const started = now();
    try {
      const result = await reader.read(ccswitchAction, usagePeriod, started);
      const text = formatCcSwitchResult(result);
      onDiagnostic(Object.freeze({
        event: "ccswitch_query", action: ccswitchAction, outcome: "ok",
        databaseSchemaVersion: result.databaseSchemaVersion ?? null,
        elapsedBucket: elapsedBucket(Math.max(0, now() - started)), rowCountBucket: rowBucket(result),
      }));
      return text;
    } catch (error) {
      const code = error instanceof CcSwitchReadError && ERROR_TEXT[error.code] ? error.code : "read_failed";
      onDiagnostic(Object.freeze({
        event: "ccswitch_query", action: ccswitchAction, outcome: code,
        databaseSchemaVersion: null, elapsedBucket: elapsedBucket(Math.max(0, now() - started)), rowCountBucket: "0",
      }));
      return ERROR_TEXT[code];
    }
  };
}

