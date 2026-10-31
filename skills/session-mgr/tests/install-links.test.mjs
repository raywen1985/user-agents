import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { installLinks, skillDirectory } from '../scripts/install-links.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'session-mgr-install-test-')));
  t.after(async () => {
    assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('session-mgr-install-test-'));
    // Unlink directory links before recursively removing the isolated test directory.
    for (const name of ['session-mgr', 'claude-session-manager']) {
      const link = path.join(root, 'skills', name);
      const stat = await fs.lstat(link).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (stat?.isSymbolicLink()) await fs.unlink(link);
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(root, 'skills'));
  return root;
}
const linkType = process.platform === 'win32' ? 'junction' : 'dir';

test('installation migrates only the expected legacy link and is idempotent', async t => {
  const root = await fixture(t), source = await fs.realpath(skillDirectory);
  const legacy = path.join(root, 'skills/claude-session-manager');
  await fs.symlink(path.join(path.dirname(source), 'claude-session-manager'), legacy, linkType);
  const result = await installLinks({ claudeRoot: root });
  assert.equal(result.migrated, true); assert.equal(await fs.realpath(result.destination), source);
  await assert.rejects(fs.lstat(legacy), { code: 'ENOENT' });
  assert.equal((await installLinks({ claudeRoot: root, check: true })).status, 'verified');
  assert.equal((await installLinks({ claudeRoot: root })).migrated, false);
});

test('migration preserves real directories and unrelated junction targets', async t => {
  const root = await fixture(t);
  const legacy = path.join(root, 'skills/claude-session-manager');
  await fs.mkdir(legacy); await fs.writeFile(path.join(legacy, 'keep.txt'), 'keep');
  await assert.rejects(installLinks({ claudeRoot: root }), /real file\/directory/);
  assert.equal(await fs.readFile(path.join(legacy, 'keep.txt'), 'utf8'), 'keep');
  const root2 = await fixture(t);
  await fs.symlink(legacy, path.join(root2, 'skills/session-mgr'), linkType);
  await assert.rejects(installLinks({ claudeRoot: root2 }), /unrelated link/);
  assert.equal(await fs.readFile(path.join(legacy, 'keep.txt'), 'utf8'), 'keep');
});
