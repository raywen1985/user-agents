import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fail, object, clone, stable, get, set } from './documents.mjs';

export const CLAUDE_TYPES = {
  autoUpdatesChannel: 'string', includeCoAuthoredBy: 'boolean', model: 'string', theme: 'string', 'permissions.defaultMode': 'string'
};
export const CODEX_TYPES = {
  model: 'string', model_reasoning_effort: 'string', disable_response_storage: 'boolean',
  'desktop.followUpQueueMode': 'string', 'desktop.conversationDetailMode': 'string',
  'desktop.toys-confetti-enabled': 'boolean', 'desktop.show-context-window-usage': 'boolean',
  'features.rmcp_client': 'boolean', 'features.memories': 'boolean', 'features.chronicle': 'boolean',
  'memories.generate_memories': 'boolean', 'memories.use_memories': 'boolean', 'windows.sandbox': 'string', 'tui.status_line': 'strings'
};
const ENV = /^(?:ANTHROPIC_BASE_URL|ANTHROPIC_DEFAULT_(?:FABLE|HAIKU|OPUS|SONNET)_MODEL(?:_NAME)?|API_TIMEOUT_MS|CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC|CLAUDE_CODE_SUBAGENT_MODEL)$/;
const SECRET = /TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|(?:^|_)KEY(?:$|_)/i;
const ABSOLUTE = /(?:^|[^A-Za-z])[a-z]:[\\/]|\\\\|\/\/(?:[^/]+)\/|\/(?:Users|home|tmp|var|opt|usr|mnt)\//i;
const norm = s => s.replaceAll('\\', '/').replace(/\/$/, '');
const powershellPrefix = 'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass';
const FILES = {
  'lark-notify': 'hooks/lark-notify.ps1', 'lark-bridge': 'hooks/Invoke-CodexNotifyBridge.ps1',
  'claude-turn': 'token-meter/ClaudeTurnHook.ps1', 'codex-turn': 'token-meter/CodexTurnHook.ps1', 'claude-status': 'token-meter/ClaudeStatusLine.ps1'
};
export function validatePolicy(p) {
  const keys = ['schemaVersion', 'clients', 'claudeFields', 'claudeEnv', 'codexFields', 'providers', 'mcpServers', 'plugins', 'commands', 'permissions'];
  if (!object(p) || p.schemaVersion !== 1 || Object.keys(p).some(k => !keys.includes(k)) || typeof p.permissions !== 'boolean') fail('invalid-policy');
  for (const key of keys.filter(k => !['schemaVersion', 'permissions'].includes(k))) {
    if (!Array.isArray(p[key]) || p[key].some(v => typeof v !== 'string' || v.length > 150) || new Set(p[key]).size !== p[key].length) fail('invalid-policy');
  }
  if (!p.clients.length || p.clients.some(x => !['claude', 'codex'].includes(x))) fail('invalid-policy');
  if (p.claudeFields.some(x => !Object.hasOwn(CLAUDE_TYPES, x)) || p.codexFields.some(x => !Object.hasOwn(CODEX_TYPES, x)) || p.claudeEnv.some(x => !ENV.test(x))) fail('invalid-policy');
  if (p.commands.some(x => ![...Object.keys(FILES), 'codex-noop'].includes(x)) || p.mcpServers.some(x => x !== 'chrome-devtools')) fail('unsupported-adapter');
  if (p.providers.some(x => !/^[a-zA-Z0-9_-]+$/.test(x)) || p.plugins.some(x => !/^[a-zA-Z0-9_-]+@[a-zA-Z0-9_-]+$/.test(x))) fail('invalid-policy');
  return p;
}
export function secretValues(docs) {
  const result = new Set();
  function walk(v, sensitive = false) {
    if (Array.isArray(v)) v.forEach(x => walk(x, sensitive));
    else if (object(v)) Object.entries(v).forEach(([k, x]) => walk(x, sensitive || SECRET.test(k)));
    else if (sensitive && typeof v === 'string' && v.length >= 6) result.add(v);
  }
  docs.forEach(d => walk(d)); return [...result];
}
export function safeString(value, ctx, { portablePath = false } = {}) {
  if (typeof value !== 'string' || value.length > 16384 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) fail('invalid-string');
  if (ctx.secrets?.some(s => value.includes(s))) fail('secret-value-reused');
  if (/\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+\S+)|(?:token|password|secret|api[_-]?key)\s*[=:]\s*\S+/i.test(value)) fail('secret-like-value');
  if (/https?:\/\//i.test(value)) {
    let url; try { url = new URL(value); } catch { fail('invalid-url'); }
    if (url.username || url.password || url.search || url.hash) fail('url-contains-private-data');
    return value;
  }
  if (!portablePath && (ABSOLUTE.test(value) || /\$\{/.test(value))) fail('nonportable-string');
  return value;
}
export function portable(value, ctx) {
  if (typeof value !== 'string' || /[\r\n]/.test(value)) fail('invalid-path');
  safeString(value, ctx, { portablePath: true });
  let p = norm(value);
  if (p.startsWith('//') && /^\/\/[a-z]\//i.test(p)) p = p[2] + ':' + p.slice(3);
  const roots = [['AGENTS_ROOT', ctx.agentsRoot], ['TEMP', ctx.tempRoot], ['USER_HOME', ctx.userHome]]
    .map(([name, root]) => [name, norm(root)]).sort((a, b) => b[1].length - a[1].length);
  for (const [name, root] of roots) {
    if (p.toLowerCase() === root.toLowerCase() || p.toLowerCase().startsWith(root.toLowerCase() + '/')) {
      p = '${' + name + '}' + p.slice(root.length); break;
    }
  }
  if (p === '~' || p.startsWith('~/')) p = '${USER_HOME}' + p.slice(1);
  if (ABSOLUTE.test(p) || p.startsWith('/') || /^[a-z]:/i.test(p)) fail('unmapped-path');
  const token = p.match(/^\$\{(AGENTS_ROOT|TEMP|USER_HOME)\}/)?.[0];
  if (p.includes('${') && (!token || p.slice(token.length).includes('${'))) fail('unknown-placeholder');
  if (p.split('/').includes('..') || /["`<>|\x00]/.test(p)) fail('unsafe-path');
  return p;
}
export function expand(value, ctx) {
  const p = portable(value, ctx);
  return p.replace(/^\$\{(AGENTS_ROOT|TEMP|USER_HOME)\}/, (_, k) => norm({ AGENTS_ROOT: ctx.agentsRoot, TEMP: ctx.tempRoot, USER_HOME: ctx.userHome }[k]));
}
function tokenScript(file) {
  return "$ProgressPreference='SilentlyContinue'\n$scriptPath=[IO.Path]::Combine([Environment]::GetFolderPath('UserProfile'),'.agents','token-meter','" + file + "')\n& $scriptPath\nexit $LASTEXITCODE";
}
export function sourceCommand(id) {
  if (id === 'codex-noop') return 'powershell.exe -NoLogo -NoProfile -NonInteractive -Command "exit 0"';
  return powershellPrefix + ' -File "${AGENTS_ROOT}/' + FILES[id] + '"' + (id === 'lark-notify' ? ' -Source claude' : '');
}
export function commandId(command, ctx) {
  if (typeof command !== 'string') return null;
  for (const id of ctx.policy.commands) {
    if (command === sourceCommand(id)) return id;
    if (id === 'codex-noop') continue;
    const directPrefix = powershellPrefix + ' -File "';
    const directSuffix = id === 'lark-notify' ? '" -Source claude' : '"';
    if (command.startsWith(directPrefix) && command.endsWith(directSuffix)) {
      const scriptPath = command.slice(directPrefix.length, -directSuffix.length);
      try {
        if (portable(scriptPath, ctx).toLowerCase() === ('${AGENTS_ROOT}/' + FILES[id]).toLowerCase()) return id;
      } catch { /* Continue to the encoded adapter or reject an owned command. */ }
    }
    if (['claude-turn', 'codex-turn', 'claude-status'].includes(id)) {
      const prefix = powershellPrefix + ' -EncodedCommand ';
      if (!command.startsWith(prefix)) continue;
      const encoded = command.slice(prefix.length);
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > 8192) continue;
      const script = Buffer.from(encoded, 'base64').toString('utf16le').replaceAll('\r\n', '\n');
      const file = FILES[id].split('/').at(-1);
      const direct = "$ProgressPreference='SilentlyContinue'\n$scriptPath='" + expand('${AGENTS_ROOT}/' + FILES[id], ctx).replaceAll("'", "''") + "'\n& $scriptPath\nexit $LASTEXITCODE";
      if (script === tokenScript(file) || script === direct) return id;
    }
  }
  // A modified owned command is a policy conflict, not a silently discarded hook.
  if (Object.values(FILES).some(f => norm(command).includes(f)) || /AIStartupHealthV1/.test(command)) fail('owner-policy-conflict');
  return null;
}
export function installedCommand(id, ctx) {
  if (id === 'codex-noop') return sourceCommand(id);
  if (['claude-turn', 'codex-turn', 'claude-status'].includes(id)) {
    const defaultRoot = norm(ctx.agentsRoot).toLowerCase() === (norm(ctx.userHome) + '/.agents').toLowerCase();
    const script = defaultRoot ? tokenScript(FILES[id].split('/').at(-1)) : "$ProgressPreference='SilentlyContinue'\n$scriptPath='" + expand('${AGENTS_ROOT}/' + FILES[id], ctx).replaceAll("'", "''") + "'\n& $scriptPath\nexit $LASTEXITCODE";
    return powershellPrefix + ' -EncodedCommand ' + Buffer.from(script, 'utf16le').toString('base64');
  }
  return sourceCommand(id).replace('${AGENTS_ROOT}/' + FILES[id], path.win32.normalize(expand('${AGENTS_ROOT}/' + FILES[id], ctx)));
}
function ownerCheck(id, event, group, h) {
  const matcher = group.matcher ?? '';
  if (id === 'lark-notify') {
    if (!['Stop', 'StopFailure', 'Notification'].includes(event) || h.timeout !== 30 ||
      matcher !== (event === 'Notification' ? 'permission_prompt|idle_prompt|agent_needs_input' : '') ||
      (event === 'Notification' ? h.async !== true : h.async !== undefined)) fail('owner-policy-conflict');
  } else if (['claude-turn', 'codex-turn'].includes(id)) {
    if (event !== 'Stop' || matcher || h.timeout !== 10 || h.async !== undefined) fail('owner-policy-conflict');
  } else if (id === 'codex-noop') {
    if (event !== 'Stop' || matcher || h.timeout !== 30 || h.async !== undefined) fail('owner-policy-conflict');
  } else fail('unsupported-hook-role');
}
function hookProjection(hooks, ctx, report) {
  const result = {};
  if (hooks === undefined) return result;
  if (!object(hooks)) fail('invalid-hooks');
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) fail('invalid-hooks');
    const seen = new Set();
    for (const group of groups) {
      if (!object(group) || !Array.isArray(group.hooks)) fail('invalid-hooks');
      for (const h of group.hooks) {
        const id = h.type === 'command' ? commandId(h.command, ctx) : null;
        if (!id) { report.skippedHooks++; continue; }
        ownerCheck(id, event, group, h);
        if (seen.has(id)) fail('duplicate-owned-hook');
        seen.add(id);
        const hook = { type: 'command', command: sourceCommand(id), timeout: h.timeout };
        if (h.async !== undefined) hook.async = h.async;
        const entry = { hooks: [hook] };
        if (group.matcher !== undefined) entry.matcher = safeString(group.matcher, ctx);
        (result[event] ??= []).push(entry);
      }
    }
    result[event]?.sort((a, b) => stable(a).localeCompare(stable(b)));
  }
  return result;
}
function field(value, type, ctx) {
  if (type === 'strings') {
    if (!Array.isArray(value)) fail('invalid-field-type');
    return value.map(x => safeString(x, ctx));
  }
  if (typeof value !== type) fail('invalid-field-type');
  if (type === 'number' && (!Number.isFinite(value) || value < 0)) fail('invalid-field-type');
  return type === 'string' ? safeString(value, ctx) : value;
}
function scalars(input, output, fields, types, ctx) {
  for (const key of fields) {
    const keys = key.split('.'), value = get(input, keys);
    if (value !== undefined) set(output, keys, field(value, types[key], ctx));
  }
}
function permission(rule, ctx) {
  if (typeof rule !== 'string') fail('invalid-permission');
  const m = /^(Read|Write|Edit|Glob|Grep)(?:\((.*)\))?$/.exec(rule);
  if (!m) fail('unsupported-permission');
  return m[2] === undefined ? rule : m[1] + '(' + portable(m[2], ctx) + ')';
}
function selectList(values, convert, report) {
  if (!Array.isArray(values)) fail('invalid-list');
  const result = [];
  for (const value of values) {
    try { result.push(convert(value)); } catch (e) {
      if (!['unmapped-path', 'unsupported-permission', 'unsafe-path'].includes(e.code)) throw e;
      report.skippedPaths++;
    }
  }
  return [...new Set(result)].sort();
}
function nativeNotify(command, ctx) {
  const root = norm(path.join(ctx.localAppData, 'OpenAI/Codex/runtimes/cua_node')).toLowerCase() + '/';
  return Array.isArray(command) && typeof command[0] === 'string' && norm(command[0]).toLowerCase().startsWith(root) &&
    path.win32.basename(command[0]).toLowerCase() === 'codex-computer-use.exe' && command[1] === 'turn-ended';
}
function bridgeProjection(command, ctx) {
  let value = command;
  if (nativeNotify(command, ctx) && command.length === 4 && command[2] === '--previous-notify') {
    try { value = JSON.parse(command[3]); } catch { fail('unsupported-notify'); }
  }
  const expected = ['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'];
  if (!Array.isArray(value) || value.length !== 8 || stable(value.slice(0, 7)) !== stable(expected) || portable(value[7], ctx) !== '${AGENTS_ROOT}/hooks/Invoke-CodexNotifyBridge.ps1') fail('unsupported-notify');
  return [...expected, '${AGENTS_ROOT}/hooks/Invoke-CodexNotifyBridge.ps1'];
}
export function project(input, kind, ctx) {
  const output = {}, report = { skippedPaths: 0, skippedHooks: 0, excludedLeaves: 0 };
  if (!object(input)) fail('invalid-root');
  if (kind === 'claude') {
    scalars(input, output, ctx.policy.claudeFields, CLAUDE_TYPES, ctx);
    for (const key of ctx.policy.claudeEnv) {
      const value = input.env?.[key];
      if (value !== undefined) set(output, ['env', key], safeString(value, ctx));
    }
    if (ctx.policy.permissions) {
      if (input.permissions?.allow !== undefined) set(output, ['permissions', 'allow'], selectList(input.permissions.allow, v => permission(v, ctx), report));
      if (input.permissions?.additionalDirectories !== undefined) set(output, ['permissions', 'additionalDirectories'], selectList(input.permissions.additionalDirectories, v => portable(v, ctx), report));
    }
    if (input.statusLine !== undefined) {
      const id = input.statusLine.type === 'command' ? commandId(input.statusLine.command, ctx) : null;
      if (id === 'claude-status') output.statusLine = { type: 'command', command: sourceCommand(id) };
      else report.skippedHooks++;
    }
  }
  if (kind === 'claude' || kind === 'hooks') {
    const hooks = hookProjection(input.hooks, ctx, report);
    if (Object.keys(hooks).length) output.hooks = hooks;
  }
  if (kind === 'codex') {
    scalars(input, output, ctx.policy.codexFields, CODEX_TYPES, ctx);
    for (const id of ctx.policy.providers) {
      const p = input.model_providers?.[id]; if (!p) continue;
      for (const key of ['name', 'wire_api', 'base_url', 'requires_openai_auth', 'env_key']) {
        if (p[key] !== undefined) set(output, ['model_providers', id, key], field(p[key], key === 'requires_openai_auth' ? 'boolean' : 'string', ctx));
      }
    }
    if (input.model_provider !== undefined) {
      if (['openai', ...ctx.policy.providers].includes(input.model_provider)) output.model_provider = input.model_provider;
      else fail('unlisted-provider-selector');
    }
    for (const id of ctx.policy.plugins) {
      const enabled = input.plugins?.[id]?.enabled;
      if (enabled !== undefined) set(output, ['plugins', id, 'enabled'], field(enabled, 'boolean', ctx));
    }
    if (input.notify !== undefined && ctx.policy.commands.includes('lark-bridge')) {
      output.notify = bridgeProjection(input.notify, ctx);
    }
    if (ctx.policy.mcpServers.includes('chrome-devtools') && input.mcp_servers?.['chrome-devtools']) {
      const mcp = input.mcp_servers['chrome-devtools'];
      const entry = '${AGENTS_ROOT}/tools/chrome-devtools-mcp/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js';
      if (!['node', 'node.exe'].includes(mcp.command) && norm(mcp.command).toLowerCase() !== norm(ctx.nodePath).toLowerCase()) fail('unsupported-mcp-command');
      if (!Array.isArray(mcp.args) || portable(mcp.args[0], ctx) !== entry || mcp.args.slice(1).some(v => !['--autoConnect', '--no-usage-statistics'].includes(v))) fail('unsupported-mcp-arguments');
      const portableMcp = { command: 'node', args: [entry, ...mcp.args.slice(1)] };
      for (const key of ['enabled', 'required', 'startup_timeout_sec', 'tool_timeout_sec']) {
        if (mcp[key] !== undefined) portableMcp[key] = field(mcp[key], key.endsWith('_sec') ? 'number' : 'boolean', ctx);
      }
      set(output, ['mcp_servers', 'chrome-devtools'], portableMcp);
    }
  }
  const count = v => object(v) ? Object.values(v).reduce((s, x) => s + count(x), 0) : 1;
  report.excludedLeaves = Math.max(0, count(input) - count(output));
  return { value: output, report };
}
export function validateSource(input, kind, ctx) {
  const output = project(input, kind, ctx).value;
  if (stable(input) !== stable(output)) fail('source-not-a-portable-projection', { config: kind });
  return output;
}
function mergeObject(a, b) {
  const result = clone(a);
  for (const [k, value] of Object.entries(b)) {
    if (['__proto__', 'constructor', 'prototype'].includes(k)) fail('unsafe-key');
    if (object(value) && result[k] !== undefined && !object(result[k])) fail('type-conflict');
    result[k] = object(value) ? mergeObject(result[k] ?? {}, value) : clone(value);
  }
  return result;
}
function mergeHooks(target, source, ctx) {
  const output = clone(target ?? {});
  for (const [event, groups] of Object.entries(source)) {
    output[event] ??= [];
    if (!Array.isArray(output[event])) fail('invalid-hooks');
    for (const group of groups) for (const h of group.hooks) {
      const id = commandId(h.command, ctx), matches = [];
      for (const [e, entries] of Object.entries(output)) for (const entry of entries) for (const [i, hook] of entry.hooks.entries()) {
        if (commandId(hook.command, ctx) !== id) continue;
        if (e !== event || (entry.matcher ?? '') !== (group.matcher ?? '')) {
          // Lark legitimately owns three separate events; only its event-local identity is compared.
          if (id === 'lark-notify' && e !== event) continue;
          fail('hook-identity-conflict');
        }
        matches.push({ entry, i, hook });
      }
      if (matches.length > 1) fail('duplicate-owned-hook');
      const resolved = { ...h, command: installedCommand(id, ctx) };
      if (matches.length) {
        const { entry, i, hook } = matches[0];
        const replacement = { ...hook, ...resolved };
        if (!Object.hasOwn(h, 'async')) delete replacement.async;
        entry.hooks[i] = replacement;
      } else output[event].push({ ...group, hooks: [resolved] });
    }
  }
  return output;
}
export function merge(target, source, kind, ctx) {
  const base = clone(source); delete base.hooks;
  if (kind === 'claude') {
    if (base.permissions) {
      for (const key of ['allow', 'additionalDirectories']) {
        if (base.permissions[key] === undefined) continue;
        const existing = target.permissions?.[key] ?? [];
        if (!Array.isArray(existing)) fail('invalid-list');
        const result = [...existing];
        for (const item of base.permissions[key]) {
          const canonicalize = v => key === 'allow' ? permission(v, ctx) : portable(v, ctx);
          if (existing.some(v => { try { return canonicalize(v) === item; } catch { return false; } })) continue;
          result.push(key === 'allow' ? item.replace(/\((.*)\)$/, (_, p) => '(' + expand(p, ctx) + ')') : expand(item, ctx));
        }
        base.permissions[key] = [...new Set(result)];
      }
    }
    if (base.statusLine) base.statusLine.command = installedCommand('claude-status', ctx);
  }
  if (kind === 'codex') {
    if (base.notify) {
      if (target.notify && stable(bridgeProjection(target.notify, ctx)) === stable(base.notify)) base.notify = clone(target.notify);
      else {
        base.notify[7] = path.win32.normalize(expand(base.notify[7], ctx));
        if (nativeNotify(target.notify, ctx) && target.notify.length === 4 && target.notify[2] === '--previous-notify') {
          bridgeProjection(target.notify, ctx);
          base.notify = [...target.notify.slice(0, 3), JSON.stringify(base.notify)];
        }
      }
    }
    if (base.mcp_servers?.['chrome-devtools']) {
      base.mcp_servers['chrome-devtools'].command = ctx.nodePath;
      base.mcp_servers['chrome-devtools'].args[0] = path.win32.normalize(expand(base.mcp_servers['chrome-devtools'].args[0], ctx));
    }
  }
  const result = mergeObject(target, base);
  if (source.hooks) result.hooks = mergeHooks(target.hooks, source.hooks, ctx);
  return result;
}
export function dependencies(sourceDocs, targetDocs, ctx) {
  const needed = new Set();
  for (const doc of Object.values(sourceDocs)) {
    if (doc.notify) needed.add('lark-bridge');
    if (doc.statusLine) needed.add('claude-status');
    for (const groups of Object.values(doc.hooks ?? {})) for (const group of groups) for (const h of group.hooks) needed.add(commandId(h.command, ctx));
  }
  for (const id of needed) {
    if (id === 'codex-noop') continue;
    if (!fs.existsSync(path.join(ctx.agentsRoot, FILES[id]))) fail('missing-component-script', { component: id });
    if (id.startsWith('lark-') && !fs.existsSync(path.join(ctx.agentsRoot, 'lark-notify.json'))) fail('missing-notification-install');
    if (id === 'lark-bridge' && !fs.existsSync(path.join(ctx.localAppData, 'lark-notify/codex-native-notify.json'))) fail('missing-notification-install');
    const safeName = value => value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().replace(/[. ]+$/, '').toLowerCase();
    const tokenRoot = process.env.TOKEN_METER_DATA_ROOT || path.join(ctx.userHome, '.agents/.token-meter-data');
    const manifest = path.join(tokenRoot, safeName(process.env.COMPUTERNAME || os.hostname()), safeName(process.env.USERNAME || os.userInfo().username), 'install-manifest.json');
    if (['claude-turn', 'codex-turn', 'claude-status'].includes(id) && !fs.existsSync(manifest)) fail('missing-token-meter-install');
  }
  const codex = sourceDocs.codex ?? {}, target = targetDocs.codex ?? {};
  if (codex.model_provider && codex.model_provider !== 'openai') {
    const id = codex.model_provider, p = { ...target.model_providers?.[id], ...codex.model_providers?.[id] };
    const authenticated = Boolean(p.experimental_bearer_token || (p.env_key && process.env[p.env_key]) || (p.requires_openai_auth && fs.existsSync(path.join(ctx.codexRoot, 'auth.json'))));
    if (!authenticated) fail('provider-auth-required', { component: 'provider' });
  }
  for (const [id, plugin] of Object.entries(codex.plugins ?? {})) {
    if (!plugin.enabled) continue;
    const [name, marketplace] = id.split('@');
    if (!target.marketplaces?.[marketplace] || !fs.existsSync(path.join(ctx.codexRoot, 'plugins/cache', marketplace, name))) fail('plugin-install-required', { component: id });
  }
  if (codex.mcp_servers?.['chrome-devtools'] && !fs.existsSync(expand(codex.mcp_servers['chrome-devtools'].args[0], ctx))) fail('chrome-devtools-install-required');
}
