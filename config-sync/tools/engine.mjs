import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { fail, parse, serialize, decode, encode, edit, stable, hash, changes } from './documents.mjs';
import { validatePolicy, secretValues, project, validateSource, merge, dependencies } from './projection.mjs';
import { stamp, lock, transact, pending, recover } from './transaction.mjs';

const toolsRoot = path.dirname(fileURLToPath(import.meta.url));
export function context(options = {}) {
  const agentsRoot = path.resolve(options.agentsRoot ?? path.join(toolsRoot, '../..'));
  const userHome = path.resolve(options.userHome ?? os.homedir());
  const codexRoot = path.resolve(options.codexRoot ?? (options.userHome ? path.join(userHome, '.codex') : process.env.CODEX_HOME || path.join(userHome, '.codex')));
  return {
    agentsRoot, userHome, codexRoot,
    tempRoot: path.resolve(options.tempRoot ?? os.tmpdir()),
    localAppData: options.localAppData ?? process.env.LOCALAPPDATA ?? path.join(userHome, 'AppData/Local'),
    nodePath: process.execPath,
    stateRoot: path.join(agentsRoot, 'local/config-sync'),
    sourceRoot: path.join(agentsRoot, 'config-sync/sources'),
    policyPath: path.join(agentsRoot, 'config-sync/policy.json'),
    codeRoot: options.codeRoot ?? path.join(agentsRoot, 'config-sync'),
    fault: options.fault
  };
}
export function definitions(ctx) {
  const defs = [];
  if (ctx.policy.clients.includes('claude')) defs.push({ id: 'claude', kind: 'json', source: path.join(ctx.sourceRoot, 'claude.settings.json'), local: path.join(ctx.userHome, '.claude/settings.json') });
  if (ctx.policy.clients.includes('codex')) defs.push(
    { id: 'codex', kind: 'toml', source: path.join(ctx.sourceRoot, 'codex.config.toml'), local: path.join(ctx.codexRoot, 'config.toml') },
    { id: 'hooks', kind: 'json', source: path.join(ctx.sourceRoot, 'codex.hooks.json'), local: path.join(ctx.codexRoot, 'hooks.json') });
  return defs;
}
function snapshot(file, kind, optional = false) {
  if (stamp(file) === 'missing') {
    if (!optional) fail('configuration-missing');
    return { path: file, hash: 'missing', bytes: null, text: '', encoding: 'utf8', bom: false, value: {} };
  }
  const bytes = fs.readFileSync(file), document = decode(bytes);
  return { path: file, hash: hash(bytes), bytes, ...document, value: parse(document.text, kind) };
}
function toolkitFiles(ctx) {
  return ['Sync-AgentConfig.ps1', 'Enable-AgentConfigWatch.ps1', 'Disable-AgentConfigWatch.ps1', 'Run-AgentConfigWatch.vbs',
    ...fs.readdirSync(path.join(ctx.codeRoot, 'tools')).filter(f => /\.(?:mjs|ps1)$|^package(?:-lock)?\.json$/.test(f)).map(f => 'tools/' + f)]
    .map(f => path.join(ctx.codeRoot, f)).filter(f => fs.existsSync(f)).sort();
}
export function configurationIdentity(ctx) {
  return hash(stable({ schema: 1, roots: [ctx.agentsRoot, ctx.userHome, ctx.codexRoot, ctx.tempRoot, ctx.localAppData, ctx.nodePath],
    policy: stamp(ctx.policyPath), code: toolkitFiles(ctx).map(f => [path.relative(ctx.codeRoot, f), stamp(f)]) }));
}
function load(ctx, mode) {
  const identity = configurationIdentity(ctx);
  ctx.policy = validatePolicy(snapshot(ctx.policyPath, 'json').value);
  const defs = definitions(ctx), locals = {}, sources = {}, localViews = {}, sourceViews = {}, reports = {};
  for (const def of defs) {
    try {
      locals[def.id] = snapshot(def.local, def.kind, mode === 'install');
      sources[def.id] = snapshot(def.source, def.kind, ['collect', 'diff'].includes(mode));
    } catch (e) { if (e.detail) e.detail.config = def.id; throw e; }
  }
  ctx.secrets = secretValues(Object.values(locals).map(d => d.value));
  for (const def of defs) {
    const result = project(locals[def.id].value, def.id, ctx);
    localViews[def.id] = result.value; reports[def.id] = result.report;
    sourceViews[def.id] = validateSource(sources[def.id].value, def.id, ctx);
  }
  const statePath = path.join(ctx.stateRoot, 'state.json');
  const stateDoc = snapshot(statePath, 'json', true);
  const state = stateDoc.hash === 'missing' ? null : stateDoc.value;
  if (state && (state.version !== 1 || !state.identity || !state.sourceHash || !state.localHash)) fail('invalid-state');
  if (identity !== configurationIdentity(ctx)) fail('concurrent-change');
  return { defs, locals, sources, localViews, sourceViews, reports, state, stateDoc, identity };
}
export function difference(local, source) {
  const paths = [];
  for (const def of new Set([...Object.keys(local), ...Object.keys(source)])) {
    const a = local[def] ?? {}, b = source[def] ?? {};
    for (const c of changes(a, b)) paths.push({ config: def, path: c.keys, change: 'source-' + c.type });
    for (const c of changes(b, a)) if (!paths.some(x => x.config === def && stable(x.path) === stable(c.keys))) paths.push({ config: def, path: c.keys, change: 'local-only' });
  }
  return paths;
}
export function direction(data) {
  if (!data.state) return 'needs-initialization';
  if (data.state.identity !== data.identity) return 'needs-rebaseline';
  const localChanged = hash(stable(data.localViews)) !== data.state.localHash;
  const sourceChanged = hash(stable(data.sourceViews)) !== data.state.sourceHash;
  return localChanged && sourceChanged ? 'conflict' : localChanged ? 'collect' : sourceChanged ? 'install' : 'unchanged';
}
export function allowedPaths(ctx) {
  return [...definitions(ctx).flatMap(d => [d.local, d.source]), path.join(ctx.stateRoot, 'state.json'), ctx.policyPath, ...toolkitFiles(ctx)];
}
export function execute(ctx, mode, options = {}) {
  if (!['collect', 'install', 'diff', 'check', 'reconcile', 'recover'].includes(mode)) fail('invalid-mode');
  const work = () => {
    ctx.policy = validatePolicy(snapshot(ctx.policyPath, 'json').value);
    if (mode === 'recover') {
      if (options.whatIf) {
        if (!pending(ctx.stateRoot).includes(options.transactionId)) fail('transaction-not-pending');
        return { status: 'preview', mode: 'recover', transaction: options.transactionId };
      }
      return recover(ctx.stateRoot, options.transactionId, allowedPaths(ctx));
    }
    const unfinished = pending(ctx.stateRoot);
    if (unfinished.length) fail('recovery-required', { transactions: unfinished });
    const data = load(ctx, mode);
    const action = direction(data);
    if (mode === 'diff') return { status: action, differences: difference(data.localViews, data.sourceViews), excluded: data.reports };
    if (mode === 'check') {
      if (['needs-initialization', 'needs-rebaseline', 'conflict'].includes(action)) fail(action);
      return { status: 'ready', next: action };
    }
    if (mode === 'reconcile') {
      if (['conflict', 'needs-initialization', 'needs-rebaseline'].includes(action)) fail(action);
      if (action === 'unchanged') return { status: 'unchanged', changedFiles: 0 };
      mode = action;
    }
    const resolution = mode === 'collect' ? 'PreferLocal' : 'PreferSource';
    if (options.resolveConflict && options.resolveConflict !== resolution) fail('invalid-resolution-direction');
    if (action === 'needs-rebaseline' && !options.rebaseline) fail('needs-rebaseline');
    if ((action === 'conflict' || (['collect', 'install'].includes(action) && action !== mode)) && options.resolveConflict !== resolution) fail('conflict');
    if (mode === 'install') dependencies(data.sourceViews, Object.fromEntries(Object.entries(data.locals).map(([k, v]) => [k, v.value])), ctx);
    const candidates = [], nextLocal = { ...data.localViews }, nextSource = { ...data.sourceViews };
    for (const def of data.defs) {
      const previous = mode === 'collect' ? data.sources[def.id] : data.locals[def.id];
      let text;
      if (mode === 'collect') {
        nextSource[def.id] = data.localViews[def.id];
        // Keep hand-written source comments/formatting if semantics already match.
        text = stable(previous.value) === stable(nextSource[def.id]) && previous.hash !== 'missing' ? previous.text : serialize(nextSource[def.id], def.kind);
      } else {
        if (data.sources[def.id].hash === 'missing') fail('source-missing');
        const merged = merge(previous.value, data.sourceViews[def.id], def.id, ctx);
        nextLocal[def.id] = project(merged, def.id, ctx).value;
        text = edit(previous.text, def.kind, merged);
      }
      // Validate every rendered file before creating the transaction.
      parse(text, def.kind);
      candidates.push({ path: previous.path, before: previous.hash, bytes: encode(text, previous) });
    }
    const changedFiles = candidates.filter(c => hash(c.bytes) !== c.before).length;
    const state = { version: 1, identity: data.identity, sourceHash: hash(stable(nextSource)), localHash: hash(stable(nextLocal)) };
    candidates.push({ path: data.stateDoc.path, before: data.stateDoc.hash, bytes: Buffer.from(serialize(state, 'json')) });
    const guards = [...Object.values(data.locals), ...Object.values(data.sources), data.stateDoc].map(d => ({ path: d.path, hash: d.hash }));
    guards.push(...[ctx.policyPath, ...toolkitFiles(ctx)].map(file => ({ path: file, hash: stamp(file) })));
    if (data.identity !== configurationIdentity(ctx)) fail('concurrent-change');
    if (options.whatIf) return { status: 'preview', mode, changedFiles, differences: difference(data.localViews, data.sourceViews), excluded: data.reports };
    const result = transact({ stateRoot: ctx.stateRoot, candidates, guards, fault: ctx.fault });
    return { status: 'success', mode, changedFiles, transaction: result.transaction, excluded: data.reports };
  };
  return options.whatIf || ['diff', 'check'].includes(mode) ? work() : lock(ctx.stateRoot, work);
}
export function gitBusy(ctx) {
  if (fs.existsSync(path.join(ctx.agentsRoot, '.git/index.lock'))) return true;
  if (!fs.existsSync(path.join(ctx.agentsRoot, '.git'))) return false;
  try { return execFileSync('git', ['-C', ctx.agentsRoot, 'ls-files', '-u'], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }).trim().length > 0; }
  catch { return true; }
}
export function rawSignature(ctx) {
  ctx.policy = validatePolicy(snapshot(ctx.policyPath, 'json').value);
  return hash(stable(definitions(ctx).flatMap(d => [stamp(d.local), stamp(d.source)])));
}
