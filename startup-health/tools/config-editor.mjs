import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { applyEdits, modify, parseTree, printParseErrorCode } from 'jsonc-parser';

export const OWNER = 'AIStartupHealthV1';
export const MATCHER = '^(startup|resume)$';

function decodeFile(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: bytes.subarray(2).toString('utf16le'), encoding: 'utf16le', bom: true };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const body = Buffer.from(bytes.subarray(2));
    for (let index = 0; index + 1 < body.length; index += 2) {
      const first = body[index];
      body[index] = body[index + 1];
      body[index + 1] = first;
    }
    return { text: body.toString('utf16le'), encoding: 'utf16be', bom: true };
  }
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  return { text: bytes.subarray(bom ? 3 : 0).toString('utf8'), encoding: 'utf8', bom };
}

function encodeFile(text, encoding, bom) {
  if (encoding === 'utf16le') {
    const body = Buffer.from(text, 'utf16le');
    return bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), body]) : body;
  }
  if (encoding === 'utf16be') {
    const body = Buffer.from(text, 'utf16le');
    for (let index = 0; index + 1 < body.length; index += 2) {
      const first = body[index];
      body[index] = body[index + 1];
      body[index + 1] = first;
    }
    return bom ? Buffer.concat([Buffer.from([0xfe, 0xff]), body]) : body;
  }
  const body = Buffer.from(text, 'utf8');
  return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
}

function visitDuplicateProperties(node, location = '$') {
  if (!node) return;
  if (node.type === 'object') {
    const keys = new Set();
    for (const property of node.children ?? []) {
      const keyNode = property.children?.[0];
      const valueNode = property.children?.[1];
      const key = String(keyNode?.value ?? '');
      if (keys.has(key)) throw new Error(`Duplicate JSON property at ${location}.${key}`);
      keys.add(key);
      visitDuplicateProperties(valueNode, `${location}.${key}`);
    }
    return;
  }
  if (node.type === 'array') {
    for (let index = 0; index < (node.children ?? []).length; index += 1) {
      visitDuplicateProperties(node.children[index], `${location}[${index}]`);
    }
  }
}

function parseDocument(text) {
  const errors = [];
  const root = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (!root || errors.length > 0) {
    const detail = errors.map((error) => `${printParseErrorCode(error.error)}@${error.offset}`).join(', ');
    throw new Error(`Invalid JSONC document: ${detail || 'empty document'}`);
  }
  if (root.type !== 'object') throw new Error('Hook configuration root must be an object.');
  visitDuplicateProperties(root);
  return root;
}

function propertyValueNode(objectNode, name) {
  const property = (objectNode?.children ?? []).find((entry) => entry.children?.[0]?.value === name);
  return property?.children?.[1] ?? null;
}

function isOwnedCommand(command, owner = OWNER) {
  if (typeof command !== 'string') return false;
  const escaped = owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\s)-Owner\\s+(?:["']?)${escaped}(?:["']?)(?:\\s|$)`, 'i').test(command);
}

function findOwnedHookPaths(root, owner = OWNER) {
  const hooksNode = propertyValueNode(root, 'hooks');
  const sessionStartNode = propertyValueNode(hooksNode, 'SessionStart');
  if (sessionStartNode?.type !== 'array') return [];
  const paths = [];
  for (let entryIndex = 0; entryIndex < (sessionStartNode.children ?? []).length; entryIndex += 1) {
    const entry = sessionStartNode.children[entryIndex];
    const entryHooks = propertyValueNode(entry, 'hooks');
    if (entryHooks?.type !== 'array') continue;
    for (let hookIndex = 0; hookIndex < (entryHooks.children ?? []).length; hookIndex += 1) {
      const hook = entryHooks.children[hookIndex];
      const command = propertyValueNode(hook, 'command')?.value;
      if (isOwnedCommand(command, owner)) {
        paths.push({ entryIndex, hookIndex, sessionStartNode, entryHooks });
      }
    }
  }
  return paths;
}

function removeArrayElement(text, arrayNode, index) {
  const children = arrayNode.children ?? [];
  const node = children[index];
  if (!node) throw new Error('Owned hook array element is unavailable.');
  let start = node.offset;
  let end = node.offset + node.length;
  if (children.length > 1 && index < children.length - 1) end = children[index + 1].offset;
  else if (children.length > 1) start = children[index - 1].offset + children[index - 1].length;
  return text.slice(0, start) + text.slice(end);
}

function formattingOptions(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const indented = text.match(/^(\s+)["'}\]]/m)?.[1] ?? '  ';
  return {
    insertSpaces: !indented.includes('\t'),
    tabSize: indented.includes('\t') ? 1 : Math.max(1, indented.length),
    eol,
  };
}

function applyModification(text, jsonPath, value, options) {
  const editOptions = options ? { formattingOptions: options } : {};
  return applyEdits(text, modify(text, jsonPath, value, editOptions));
}

function removeOwnedHooks(text, owner, options) {
  let working = text;
  while (true) {
    const root = parseDocument(working);
    const owned = findOwnedHookPaths(root, owner);
    if (owned.length === 0) return working;
    const target = owned[owned.length - 1];
    working = target.entryHooks.children.length === 1
      ? removeArrayElement(working, target.sessionStartNode, target.entryIndex)
      : removeArrayElement(working, target.entryHooks, target.hookIndex);
  }
}

export function editHookText(sourceText, { action, command, owner = OWNER } = {}) {
  parseDocument(sourceText);
  if (!['install', 'remove'].includes(action)) throw new Error('Action must be install or remove.');
  if (action === 'install' && (typeof command !== 'string' || command.trim().length === 0)) {
    throw new Error('Install action requires a non-empty command.');
  }
  const options = formattingOptions(sourceText);
  const hadFinalNewline = /(?:\r\n|\n)$/.test(sourceText);
  let result = removeOwnedHooks(sourceText, owner, options);
  if (action === 'install') {
    const ownedEntry = {
      matcher: MATCHER,
      hooks: [{ type: 'command', command, timeout: 75, async: true }],
    };
    const root = parseDocument(result);
    const hooksNode = propertyValueNode(root, 'hooks');
    const sessionStartNode = propertyValueNode(hooksNode, 'SessionStart');
    if (!hooksNode) result = applyModification(result, ['hooks'], { SessionStart: [ownedEntry] }, options);
    else if (!sessionStartNode) result = applyModification(result, ['hooks', 'SessionStart'], [ownedEntry], options);
    else if (sessionStartNode.type !== 'array') throw new Error('hooks.SessionStart must be an array.');
    else result = applyModification(result, ['hooks', 'SessionStart', -1], ownedEntry, options);
  }
  parseDocument(result);
  if (hadFinalNewline && !/(?:\r\n|\n)$/.test(result)) result += options.eol;
  if (!hadFinalNewline) result = result.replace(/(?:\r\n|\n)+$/, '');
  return result;
}

export function editHookFile({ inputPath, outputPath, action, command, owner = OWNER }) {
  const decoded = decodeFile(fs.readFileSync(inputPath));
  const edited = editHookText(decoded.text, { action, command, owner });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, encodeFile(edited, decoded.encoding, decoded.bom), { flag: 'wx' });
  return { encoding: decoded.encoding, bom: decoded.bom, ownedHookCount: findOwnedHookPaths(parseDocument(edited), owner).length };
}

function parseArguments(argv) {
  const [action, ...rest] = argv;
  const values = { action };
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`Invalid argument: ${key ?? ''}`);
    values[key.slice(2)] = value;
  }
  return values;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (value) => value.slice(1)))) {
  try {
    const args = parseArguments(process.argv.slice(2));
    const summary = editHookFile({
      inputPath: args.input,
      outputPath: args.output,
      action: args.action,
      command: args.command,
      owner: args.owner ?? OWNER,
    });
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
