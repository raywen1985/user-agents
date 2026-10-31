import { parseTree, getNodeValue, modify, applyEdits } from 'jsonc-parser';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { parseForESLint } from 'toml-eslint-parser';
import { createHash } from 'node:crypto';

export class SyncError extends Error {
  constructor(code, detail = {}) { super(code); this.code = code; this.detail = detail; }
}
export const fail = (code, detail) => { throw new SyncError(code, detail); };
export const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export const clone = v => structuredClone(v);
export function canonical(v) {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(canonical);
  if (object(v)) return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])]));
  return v;
}
export const stable = v => JSON.stringify(canonical(v));
export const hash = v => createHash('sha256').update(v).digest('hex');
export const get = (v, keys) => keys.reduce((a, k) => object(a) && Object.hasOwn(a, k) ? a[k] : undefined, v);
export function set(v, keys, value) {
  for (const k of keys.slice(0, -1)) {
    if (['__proto__', 'constructor', 'prototype'].includes(k)) fail('unsafe-key');
    if (!Object.hasOwn(v, k)) v[k] = {};
    if (!object(v[k])) fail('type-conflict');
    v = v[k];
  }
  const last = keys.at(-1);
  if (['__proto__', 'constructor', 'prototype'].includes(last)) fail('unsafe-key');
  v[last] = value;
}
function inspectNode(node) {
  if (node.type === 'object') {
    const keys = new Set();
    for (const p of node.children ?? []) {
      const key = p.children[0].value;
      if (keys.has(key)) fail('duplicate-json-key');
      if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('unsafe-key');
      keys.add(key); inspectNode(p.children[1]);
    }
  } else if (node.type === 'array') node.children?.forEach(inspectNode);
}
export function parse(text, kind) {
  try {
    if (kind === 'toml') {
      const value = parseToml(text);
      // Both parsers must accept a document before it can be edited.
      parseForESLint(text);
      return value;
    }
    const errors = [];
    const tree = parseTree(text, errors, { allowTrailingComma: true });
    if (errors.length || tree?.type !== 'object') fail('invalid-json', { offset: errors[0]?.offset ?? 0 });
    inspectNode(tree);
    return getNodeValue(tree);
  } catch (error) {
    if (error instanceof SyncError) throw error;
    // Never echo a parser's source excerpt: it can contain a secret.
    fail('invalid-toml', { line: error.line ?? error.lineNumber ?? 0, column: error.column ?? 0 });
  }
}
export function decode(bytes) {
  if (bytes?.[0] === 0xff && bytes?.[1] === 0xfe) return { text: bytes.subarray(2).toString('utf16le'), encoding: 'utf16le', bom: true };
  if (bytes?.[0] === 0xfe && bytes?.[1] === 0xff) fail('unsupported-encoding');
  const bom = bytes?.subarray(0, 3).equals(Buffer.from([239, 187, 191])) ?? false;
  const body = bytes?.subarray(bom ? 3 : 0) ?? Buffer.alloc(0);
  try { new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { fail('invalid-encoding'); }
  return { text: body.toString('utf8'), encoding: 'utf8', bom };
}
export function encode(text, original) {
  const { encoding, bom } = original;
  return Buffer.concat([bom ? Buffer.from(encoding === 'utf16le' ? [255, 254] : [239, 187, 191]) : Buffer.alloc(0), Buffer.from(text, encoding)]);
}
export function serialize(value, kind) {
  return kind === 'toml' ? stringifyToml(canonical(value)) : JSON.stringify(canonical(value), null, 2) + '\n';
}
export function changes(before, after, keys = []) {
  if (stable(before) === stable(after)) return [];
  if (object(after) && object(before)) return Object.keys(after).flatMap(k => changes(before[k], after[k], [...keys, k]));
  return [{ keys, value: after, type: before === undefined ? 'added' : 'changed' }];
}
function tomlValue(value) {
  // Render a value in an inline table so the serializer cannot emit a new table.
  const scalar = v => {
    if (typeof v === 'string') return JSON.stringify(v).replaceAll('\\u0008', '\\b').replaceAll('\\u000c', '\\f');
    if (Array.isArray(v)) return '[' + v.map(scalar).join(', ') + ']';
    if (object(v)) return '{ ' + Object.entries(v).map(([k, x]) => JSON.stringify(k) + ' = ' + scalar(x)).join(', ') + ' }';
    if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return String(v);
    fail('unsupported-toml-value');
  };
  return scalar(value);
}
const prefix = (a, b) => a.length <= b.length && a.every((v, i) => v === b[i]);
function editToml(text, change, after) {
  const ast = parseForESLint(text).ast;
  const root = ast.body[0];
  const candidates = [root, ...root.body.filter(t => t.type === 'TOMLTable')];
  let insertion = null;
  for (const table of candidates) {
    const base = table.type === 'TOMLTopLevelTable' ? [] : table.resolvedKey;
    if (!base || base.some(k => typeof k !== 'string') || !prefix(base, change.keys)) continue;
    for (const kv of table.body ?? []) {
      if (kv.type !== 'TOMLKeyValue') continue;
      const keys = [...base, ...kv.key.keys.map(k => k.type === 'TOMLBare' ? k.name : k.value)];
      if (prefix(keys, change.keys)) {
        const value = tomlValue(get(after, keys));
        return text.slice(0, kv.value.range[0]) + value + text.slice(kv.value.range[1]);
      }
    }
    if (!insertion || base.length > insertion.base.length) insertion = { table, base };
  }
  if (!insertion) insertion = { table: root, base: [] };
  const { table, base } = insertion;
  const next = table === root ? candidates[1] : candidates.find(t => t !== root && t.range[0] > table.range[0]);
  const offset = next?.range[0] ?? text.length;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const line = change.keys.slice(base.length).map(k => JSON.stringify(k)).join('.') + ' = ' + tomlValue(change.value) + eol;
  return text.slice(0, offset) + (offset && !text.slice(0, offset).endsWith('\n') ? eol : '') + line + text.slice(offset);
}
export function edit(text, kind, after) {
  const original = text.trim() ? parse(text, kind) : {};
  const updates = changes(original, after);
  if (!updates.length) return text;
  if (kind !== 'toml' && !text.trim()) text = '{}\n';
  for (const change of updates) {
    text = kind === 'toml' ? editToml(text, change, after) : applyEdits(text, modify(text, change.keys, change.value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes('\r\n') ? '\r\n' : '\n' } }));
  }
  if (stable(parse(text, kind)) !== stable(after)) fail('edit-validation-failed');
  return text;
}
