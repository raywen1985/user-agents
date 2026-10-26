import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createCodexExecutableResolver,
  validateCodexExecutableConfig,
} from "../src/codex-executable.mjs";
import { createInitializedCodexClient } from "../src/executors/codex.mjs";

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-resolver-test-"));
}

function createExecutable(filePath, mtimeMs = Date.now()) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "test", "utf8");
  const timestamp = new Date(mtimeMs);
  fs.utimesSync(filePath, timestamp, timestamp);
  return filePath;
}

function canonical(filePath) {
  return fs.realpathSync.native(filePath);
}

function desktopExecutable(localAppData, version) {
  return path.join(localAppData, "OpenAI", "Codex", "bin", version, "codex.exe");
}

function npmExecutable(appData, arch = "x64") {
  const [packageName, target] = arch === "arm64"
    ? ["codex-win32-arm64", "aarch64-pc-windows-msvc"]
    : ["codex-win32-x64", "x86_64-pc-windows-msvc"];
  return path.join(
    appData,
    "npm",
    "node_modules",
    "@openai",
    "codex",
    "node_modules",
    "@openai",
    packageName,
    "vendor",
    target,
    "bin",
    "codex.exe",
  );
}

test("Codex configuration accepts auto or an absolute codex.exe path", () => {
  assert.doesNotThrow(() => validateCodexExecutableConfig("auto"));
  assert.doesNotThrow(() => validateCodexExecutableConfig(path.resolve("codex.exe")));
  assert.throws(() => validateCodexExecutableConfig("codex.exe"), /absolute/);
  assert.throws(() => validateCodexExecutableConfig(path.resolve("codex.cmd")), /codex\.exe/);
  assert.throws(() => validateCodexExecutableConfig(null), /absolute/);
});

test("explicit Codex path is preflighted and never falls back", async () => {
  const root = tempDirectory();
  try {
    const executable = createExecutable(path.join(root, "codex.exe"));
    const resolver = createCodexExecutableResolver({
      configured: executable,
      env: {},
      preflight: async () => ({ ok: true }),
    });
    assert.deepEqual(await resolver.resolve(), { executable: canonical(executable), source: "explicit" });

    const failing = createCodexExecutableResolver({
      configured: executable,
      env: {},
      preflight: async () => ({ ok: false, reason: "broken" }),
    });
    await assert.rejects(() => failing.resolve(), /Explicit Codex executable.*broken/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("auto mode selects the newest valid desktop candidate deterministically", async () => {
  const root = tempDirectory();
  try {
    const older = createExecutable(desktopExecutable(root, "old"), 1000);
    const newer = createExecutable(desktopExecutable(root, "new"), 2000);
    const seen = [];
    const resolver = createCodexExecutableResolver({
      configured: "auto",
      env: { LOCALAPPDATA: root },
      preflight: async (candidate) => { seen.push(candidate); return { ok: true }; },
    });
    assert.deepEqual(await resolver.resolve(), { executable: canonical(newer), source: "desktop" });
    assert.deepEqual(seen, [canonical(newer)]);

    fs.utimesSync(older, new Date(2000), new Date(2000));
    const tied = createCodexExecutableResolver({
      configured: "auto",
      env: { LOCALAPPDATA: root },
      preflight: async () => ({ ok: true }),
    });
    const expected = [canonical(older), canonical(newer)].sort((left, right) => {
      const lower = left.toLowerCase() < right.toLowerCase() ? -1 : left.toLowerCase() > right.toLowerCase() ? 1 : 0;
      return lower || (left < right ? -1 : left > right ? 1 : 0);
    })[0];
    assert.equal((await tied.resolve()).executable, expected);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("auto mode skips failed desktop preflight and falls back to npm", async () => {
  const localAppData = tempDirectory();
  const appData = tempDirectory();
  try {
    const desktop = createExecutable(desktopExecutable(localAppData, "current"), 2000);
    const npm = createExecutable(npmExecutable(appData), 1000);
    const resolver = createCodexExecutableResolver({
      configured: "auto",
      env: { LOCALAPPDATA: localAppData, APPDATA: appData },
      arch: "x64",
      preflight: async (candidate) => candidate === canonical(desktop)
        ? { ok: false, reason: "missing app-server" }
        : { ok: true },
    });
    assert.deepEqual(await resolver.resolve(), { executable: canonical(npm), source: "npm" });
  } finally {
    fs.rmSync(localAppData, { recursive: true, force: true });
    fs.rmSync(appData, { recursive: true, force: true });
  }
});

test("auto mode handles missing roots and unsupported architecture", async () => {
  const resolver = createCodexExecutableResolver({
    configured: "auto",
    env: {},
    arch: "ia32",
    preflight: async () => ({ ok: true }),
  });
  await assert.rejects(
    () => resolver.resolve(),
    (error) => /LOCALAPPDATA is not set/.test(error.message)
      && /APPDATA is not set/.test(error.message),
  );

  const appData = tempDirectory();
  try {
    fs.mkdirSync(path.join(appData, "npm", "node_modules", "@openai"), { recursive: true });
    const unsupported = createCodexExecutableResolver({ configured: "auto", env: { APPDATA: appData }, arch: "ia32" });
    await assert.rejects(() => unsupported.resolve(), /unsupported architecture ia32/);
  } finally {
    fs.rmSync(appData, { recursive: true, force: true });
  }
});

test("invalidated auto candidate is skipped once and then reconsidered", async () => {
  const root = tempDirectory();
  try {
    const newest = createExecutable(desktopExecutable(root, "new"), 2000);
    const older = createExecutable(desktopExecutable(root, "old"), 1000);
    const resolver = createCodexExecutableResolver({
      configured: "auto",
      env: { LOCALAPPDATA: root },
      preflight: async () => ({ ok: true }),
    });
    const first = await resolver.resolve();
    assert.equal(first.executable, canonical(newest));
    resolver.invalidate(first.executable);
    assert.equal((await resolver.resolve()).executable, canonical(older));
    assert.equal((await resolver.resolve()).executable, canonical(newest));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("auto discovery rejects linked desktop version directories", async (t) => {
  const root = tempDirectory();
  const outside = tempDirectory();
  try {
    createExecutable(path.join(outside, "codex.exe"));
    const bin = path.join(root, "OpenAI", "Codex", "bin");
    fs.mkdirSync(bin, { recursive: true });
    try {
      fs.symlinkSync(outside, path.join(bin, "linked"), "junction");
    } catch (error) {
      t.skip(`junction creation is unavailable: ${error.code}`);
      return;
    }
    const resolver = createCodexExecutableResolver({ configured: "auto", env: { LOCALAPPDATA: root } });
    await assert.rejects(() => resolver.resolve(), /auto-resolution failed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("initial auto ENOENT invalidates and retries exactly once", async () => {
  const selections = [
    { executable: "C:\\old\\codex.exe", source: "desktop" },
    { executable: "C:\\new\\codex.exe", source: "desktop" },
  ];
  const invalidated = [];
  const clients = [];
  const clientFactory = (executable) => {
    const client = {
      executable,
      closed: false,
      async request() {
        if (executable.includes("old")) throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
        return {};
      },
      notify() {},
      close() { this.closed = true; },
    };
    clients.push(client);
    return client;
  };
  const result = await createInitializedCodexClient({
    cwd: process.cwd(),
    resolveExecutable: async () => selections.shift(),
    invalidateExecutable: async (executable) => invalidated.push(executable),
    clientFactory,
  });
  assert.equal(result.selection.executable, "C:\\new\\codex.exe");
  assert.deepEqual(invalidated, ["C:\\old\\codex.exe"]);
  assert.equal(clients.length, 2);
  assert.equal(clients[0].closed, true);
});

test("explicit initialization failure never retries", async () => {
  let resolutions = 0;
  await assert.rejects(() => createInitializedCodexClient({
    cwd: process.cwd(),
    resolveExecutable: async () => {
      resolutions += 1;
      return { executable: "C:\\missing\\codex.exe", source: "explicit" };
    },
    clientFactory: () => ({
      request: async () => { throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }); },
      notify() {},
      close() {},
    }),
  }), /ENOENT/);
  assert.equal(resolutions, 1);
});
