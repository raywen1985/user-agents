import { listManagedSessions } from './harnesses.mjs';
import { byRecentActivity } from './claude-reader.mjs';

const label = harness => harness === 'claude' ? 'Claude Code' : 'Codex';
const clean = value => String(value || '').replace(/[\p{Cc}\p{Cs}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, ' ').replace(/\s+/g, ' ').trim();
const shortName = value => { const chars = [...clean(value)]; return chars.length > 160 ? `${chars.slice(0, 159).join('')}…` : chars.join(''); };

// Read-only global listing; separate calls retain each harness's data root and
// allow a failed source to report partial results from the other source.
export async function collectSessionList({ harness = 'all', claudeRoot, codexRoot, codexBin,
  resolveCodexBin = async () => codexBin,
  readSessions = listManagedSessions } = {}) {
  if (!['claude', 'codex', 'all'].includes(harness)) throw new Error('Unsupported session harness');
  const targets = harness === 'all' ? ['claude', 'codex'] : [harness];
  const results = await Promise.allSettled(targets.map(async target => readSessions({
    harness: target, scope: 'all', root: target === 'claude' ? claudeRoot : codexRoot,
    ...(target === 'codex' ? { codexBin: await resolveCodexBin() } : {}),
    maximumProjectDirectories: 2048, maximumEntries: 20000,
  })));
  const sessions = [], warnings = [];
  let complete = true;
  for (const [index, result] of results.entries()) {
    const target = targets[index];
    if (result.status === 'rejected') {
      complete = false;
      warnings.push(`${label(target)} 读取失败（${clean(result.reason?.code) || '数据源不可用'}）`);
      continue;
    }
    const value = result.value;
    complete &&= value.complete === true;
    sessions.push(...value.sessions.map(session => ({ ...session, harness: target })));
    if (!value.complete) warnings.push(`${label(target)} 扫描不完整`);
    if (value.warnings?.length) warnings.push(`${label(target)} 有 ${value.warnings.length} 条读取或状态核验警告`);
  }
  sessions.sort(byRecentActivity);
  return { harness, scope: 'all', sessions, total: sessions.length, complete, warnings };
}

function time(value, timeZone) {
  const date = new Date(value || '');
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('zh-CN', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date) : '未知';
}

function entry(session, index, timeZone) {
  const projects = session.projects?.length ? session.projects : session.project ? [session.project] : [];
  const status = { active: '进程占用（可能空闲）', inactive: '未发现进程占用', unknown: '占用状态未知' }[session.activity?.state] || '占用状态未知';
  const derived = /prompt|summary/.test(session.nameSource || '') ? '（摘要/首条输入代名）' : '';
  return [
    `${index + 1}. ${label(session.harness)} | ${shortName(session.name) || '未命名'}${derived}`,
    `ID：${clean(session.id)}`,
    `项目${projects.length > 1 ? '（记录涉及多个路径）' : ''}：${projects.map(clean).join('；') || '未知'}`,
    `最近活动：${time(session.lastActiveAt || session.updatedAt, timeZone)} | ${status}${session.archived ? ' | 已归档' : ''}`,
  ].join('\n');
}

// Every row is emitted. Long rows continue in subsequent messages instead of
// truncating IDs or paths. Reserve space for the Gateway envelope and headings.
export function formatSessionListPages(result, { maxBytes = 12000, maxEntries = 25, timeZone = 'Asia/Shanghai' } = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes < 2048) throw new Error('Session page size must be at least 2048 bytes');
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error('Session page entry limit must be positive');
  const sessions = [...result.sessions].sort(byRecentActivity);
  const heading = `${result.harness === 'all' ? '本机 Agent' : label(result.harness)} 会话列表 | 全部项目 | 共 ${sessions.length} 条${result.complete ? '' : '（扫描不完整，仅已读到的记录）'}`;
  const note = `按最近活动倒序；时区 ${timeZone}。占用不等于正在工作；序号仅供阅读。`;
  const warnings = result.warnings?.length ? `\n警告：${result.warnings.map(clean).join('；')}` : '';
  const prefix = `${heading}\n${note}${warnings}`;
  const budget = maxBytes - Buffer.byteLength(prefix, 'utf8') - 256;
  if (budget < 256) throw new Error('Session list heading exceeds page size');
  const chunks = [];
  let body = '', start = 1, end = 0;
  const flush = () => { if (body) chunks.push({ body, start, end }); body = ''; };
  for (const [index, session] of sessions.entries()) {
    const row = entry(session, index, timeZone);
    if (body && (index + 1 - start >= maxEntries || Buffer.byteLength(`${body}\n\n${row}`, 'utf8') > budget)) flush();
    if (!body) start = index + 1;
    end = index + 1;
    if (Buffer.byteLength(row, 'utf8') <= budget) { body += `${body ? '\n\n' : ''}${row}`; continue; }
    for (const char of row) {
      if (Buffer.byteLength(body + char, 'utf8') > budget) { flush(); start = index + 1; }
      body += char;
    }
  }
  flush();
  if (!chunks.length) chunks.push({ body: result.complete ? '没有发现会话。' : '暂未读到会话，不能判定没有会话。', start: 0, end: 0 });
  return chunks.map((chunk, index) => `${prefix}\n第 ${index + 1}/${chunks.length} 批 | 条目 ${chunk.start}–${chunk.end}\n\n${chunk.body}`);
}
