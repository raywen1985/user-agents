import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { backfillOverrideAuthorities, revalidateProjectAuthority } from "../src/project-guard.mjs";
import { Store } from "../src/store.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-guard-"));
  const projectPath = path.join(root, "project");
  fs.mkdirSync(projectPath);
  const store = new Store(path.join(root, "gateway.sqlite"));
  return { root, projectPath: fs.realpathSync.native(projectPath), store };
}

test("Gateway rows without native or override evidence are not project authority", async () => {
  const { root, projectPath, store } = fixture();
  try {
    const session = store.createSession({ executor: "claude", projectAlias: "legacy", projectPath, name: "legacy" });
    const result = await revalidateProjectAuthority(session, { config: { projects: [], excludedRoots: [] }, store });
    assert.deepEqual(result, { ok: false, reason: "project_unverified" });
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("explicit local overrides backfill and revalidate existing sessions", async () => {
  const { root, projectPath, store } = fixture();
  const override = { alias: "project", path: projectPath, aliases: [] };
  const config = { projects: [override], excludedRoots: [] };
  try {
    const session = store.createSession({ executor: "codex", projectAlias: "project", projectPath, name: "existing" });
    backfillOverrideAuthorities(config, store);
    assert.equal(store.getProjectAuthority(session.id).source_type, "override");
    assert.deepEqual(await revalidateProjectAuthority(session, { config, store }), { ok: true });
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("Claude transcript evidence is revalidated against exact cwd", async () => {
  const { root, projectPath, store } = fixture();
  const id = "99999999-9999-4999-8999-999999999999";
  const sourcePath = path.join(root, "projects", "fixture", `${id}.jsonl`);
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, JSON.stringify({ type: "user", sessionId: id, cwd: projectPath }));
  const config = { projects: [], excludedRoots: [] };
  try {
    const session = store.createSession({ executor: "claude", projectAlias: "project", projectPath, nativeId: id, name: "existing" });
    store.setProjectAuthority(session.id, { alias: "project", path: projectPath }, {
      sourceType: "native", provider: "claude", nativeId: id, sourcePath,
    });
    assert.deepEqual(await revalidateProjectAuthority(session, { config, store }), { ok: true });
    const excluded = { projects: [], excludedRoots: [projectPath] };
    assert.deepEqual(await revalidateProjectAuthority(session, { config: excluded, store }), { ok: false, reason: "project_excluded" });
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
