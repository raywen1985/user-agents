import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, mergeGatewayConfig, mergeProjectPolicy } from "../src/config.mjs";

test("local gateway objects merge by property while arrays replace", () => {
  const merged = mergeGatewayConfig({
    allowedOpenIds: ["base"],
    executables: { codex: "auto" },
    voice: { enabled: true, maxBytes: 10 },
  }, {
    allowedOpenIds: ["local"],
    executables: { node: "node.exe" },
    voice: { enabled: false },
  });
  assert.deepEqual(merged.allowedOpenIds, ["local"]);
  assert.deepEqual(merged.executables, { codex: "auto", node: "node.exe" });
  assert.deepEqual(merged.voice, { enabled: false, maxBytes: 10 });
});

test("project policy local arrays replace base arrays", () => {
  assert.deepEqual(mergeProjectPolicy({ projects: [{ alias: "base" }], excludedRoots: ["base"] }, {
    projects: [{ alias: "local" }],
  }), { projects: [{ alias: "local" }], excludedRoots: ["base"] });
});

test("configuration layers reject unknown, null, and mismatched values", () => {
  assert.throws(() => mergeGatewayConfig({}, { surprise: true }), /Unknown/);
  assert.throws(() => mergeGatewayConfig({}, { routerModel: null }), /must not be null/);
  assert.throws(() => mergeGatewayConfig({}, { executables: [] }), /must be an object/);
  assert.throws(() => mergeGatewayConfig({}, { voice: { timeoutMs: null } }), /must not be null/);
  assert.throws(() => mergeGatewayConfig({}, { voice: { surprise: true } }), /Unknown/);
  assert.throws(() => mergeProjectPolicy({}, { projects: {} }), /must be an array/);
});

test("relative executable paths resolve within the project root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-config-layer-"));
  const configDirectory = path.join(root, "config");
  const binDirectory = path.join(root, "bin");
  fs.mkdirSync(configDirectory);
  fs.mkdirSync(binDirectory);
  for (const name of ["node", "lark", "claude", "ffmpeg", "svn"]) fs.writeFileSync(path.join(binDirectory, `${name}.exe`), "fixture");
  fs.writeFileSync(path.join(configDirectory, "gateway.json"), JSON.stringify({
    allowedOpenIds: ["user"], recipientOpenId: "user",
    executables: { codex: "auto" },
  }));
  fs.writeFileSync(path.join(configDirectory, "gateway.local.json"), JSON.stringify({
    executables: Object.fromEntries(["node", "larkCli", "claude", "ffmpeg", "svn"].map((name) => [
      name, `bin/${name === "larkCli" ? "lark" : name}.exe`,
    ])),
  }));
  fs.writeFileSync(path.join(configDirectory, "projects.json"), JSON.stringify({ projects: [], excludedRoots: [] }));
  try {
    const config = loadConfig({ rootPath: root, configDirectory });
    assert.equal(config.gateway.executables.node, fs.realpathSync.native(path.join(binDirectory, "node.exe")));
    assert.equal(config.gateway.claudeExecutionMode, "restricted");
    const basePath = path.join(configDirectory, "gateway.json");
    const base = JSON.parse(fs.readFileSync(basePath, "utf8"));
    fs.writeFileSync(basePath, JSON.stringify({ ...base, claudeExecutionMode: "full_access" }));
    assert.equal(loadConfig({ rootPath: root, configDirectory }).gateway.claudeExecutionMode, "full_access");
    fs.writeFileSync(basePath, JSON.stringify({ ...base, claudeExecutionMode: "typo" }));
    assert.throws(() => loadConfig({ rootPath: root, configDirectory }), /Unsupported Claude execution mode/);
    fs.writeFileSync(basePath, JSON.stringify(base));
    fs.writeFileSync(path.join(configDirectory, "gateway.local.json"), JSON.stringify({
      executables: { node: "../outside.exe" },
    }));
    assert.throws(() => loadConfig({ rootPath: root, configDirectory }), /escapes the project root/);
    fs.writeFileSync(path.join(configDirectory, "gateway.local.json"), JSON.stringify({
      executables: Object.fromEntries(["node", "larkCli", "claude", "ffmpeg", "svn"].map((name) => [
        name, `bin/${name === "larkCli" ? "lark" : name}.exe`,
      ])),
    }));
    fs.writeFileSync(path.join(configDirectory, "projects.local.json"), JSON.stringify({
      projects: [], excludedRoots: ["../outside"],
    }));
    assert.throws(() => loadConfig({ rootPath: root, configDirectory }), /Excluded root escapes/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
