#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { defaultRoot } from './session-store.mjs';

export const skillDirectory = fileURLToPath(new URL('..', import.meta.url));
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
const statOrNull = file => fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });

async function checkLink(link, expected) {
  const stat = await statOrNull(link);
  if (!stat) return false;
  if (!stat.isSymbolicLink()) throw new Error(`Refusing to overwrite a real file/directory: ${link}`);
  const target = path.resolve(path.dirname(link), await fs.readlink(link));
  if (key(target) !== key(path.resolve(expected))) throw new Error(`Refusing to replace an unrelated link: ${link}`);
  return true;
}

export async function installLinks({ claudeRoot, check = false } = {}) {
  const source = await fs.realpath(skillDirectory);
  const directory = path.join(defaultRoot(claudeRoot), 'skills');
  const destination = path.join(directory, 'session-mgr');
  const legacy = path.join(directory, 'claude-session-manager');
  const expectedLegacy = path.join(path.dirname(source), 'claude-session-manager');
  // Validate both before changing either; never recursively remove a skill directory.
  const installed = await checkLink(destination, source);
  const oldLink = await checkLink(legacy, expectedLegacy);
  if (check && (!installed || oldLink)) throw new Error('SessionMgr link migration is incomplete; run install-links.mjs first');
  if (!check) {
    await fs.mkdir(directory, { recursive: true });
    if (!installed) await fs.symlink(source, destination, process.platform === 'win32' ? 'junction' : 'dir');
  }
  if (key(await fs.realpath(destination)) !== key(source)) throw new Error('Installed skill link resolves to the wrong source');
  await fs.access(path.join(destination, 'SKILL.md'));
  if (!check && oldLink) { await checkLink(legacy, expectedLegacy); await fs.unlink(legacy); }
  return { status: check ? 'verified' : 'installed', source, destination, migrated: !check && oldLink };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { 'claude-root': { type: 'string' }, check: { type: 'boolean' } }, strict: true });
    console.log(JSON.stringify(await installLinks({ claudeRoot: values['claude-root'], check: values.check }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
