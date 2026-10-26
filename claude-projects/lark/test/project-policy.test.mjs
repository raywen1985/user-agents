import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  finalizeProjectDisplays,
  isExcludedProject,
  isPathWithin,
  matchProjects,
  normalizeProjectQuery,
  projectFromPath,
  projectPathsConflict,
} from "../src/project-policy.mjs";

test("project queries never turn paths into authority", () => {
  assert.equal(normalizeProjectQuery("client"), "client");
  assert.equal(normalizeProjectQuery("D:\\ulibs\\client"), null);
  assert.equal(normalizeProjectQuery("..\\client"), null);
});

test("duplicate discovered labels remain ambiguous and display their paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-policy-labels-"));
  const firstPath = path.join(root, "one", "client");
  const secondPath = path.join(root, "two", "client");
  fs.mkdirSync(firstPath, { recursive: true });
  fs.mkdirSync(secondPath, { recursive: true });
  try {
    const config = { projects: [], excludedRoots: [] };
    const projects = finalizeProjectDisplays([
      projectFromPath(config, firstPath),
      projectFromPath(config, secondPath),
    ]);
    const match = matchProjects("client", projects);
    assert.equal(match.kind, "selection");
    assert.equal(match.projects.length, 2);
    assert.equal(match.projects.every((project) => project.display.includes(project.path)), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("exclusions and scheduler conflicts include descendant roots", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-policy-roots-"));
  const child = path.join(root, "child");
  const sibling = fs.mkdtempSync(path.join(os.tmpdir(), "project-policy-sibling-"));
  fs.mkdirSync(child);
  try {
    assert.equal(isExcludedProject({ excludedRoots: [root] }, child), true);
    assert.equal(isPathWithin(path.parse(root).root, child), true);
    assert.equal(projectPathsConflict(root, child), true);
    assert.equal(projectPathsConflict(child, sibling), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(sibling, { recursive: true, force: true });
  }
});
