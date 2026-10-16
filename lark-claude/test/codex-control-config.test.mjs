import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateCodexControlConfig } from "../src/config.mjs";

function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-control-config-"));
  const homeDirectory = path.join(root, "home");
  const localAppData = path.join(root, "local");
  const socketRoot = path.join(homeDirectory, ".codex", "app-server-control");
  const secretRoot = path.join(localAppData, "lark-claude", "secrets");
  fs.mkdirSync(socketRoot, { recursive: true });
  fs.mkdirSync(secretRoot, { recursive: true });
  const socketPath = path.join(socketRoot, "desktop.sock");
  const tokenFile = path.join(secretRoot, "desktop.token");
  fs.writeFileSync(socketPath, "socket");
  fs.writeFileSync(tokenFile, "secret");
  try { return run({ homeDirectory, localAppData, socketPath, tokenFile, root }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("Codex control is disabled safely when no endpoints are configured", () => {
  assert.deepEqual(validateCodexControlConfig(null), {
    endpoints: [], connectTimeoutMs: 1000, requestTimeoutMs: 2000, maxFrameBytes: 262144,
  });
});

test("Codex control accepts fixed local proxy and loopback WebSocket endpoints", () => {
  fixture(({ homeDirectory, localAppData, socketPath, tokenFile }) => {
    const config = validateCodexControlConfig({
      endpoints: [
        { id: "proxy", transport: "proxy", socketPath },
        { id: "ws", transport: "websocket", url: "ws://127.0.0.1:4500/control", tokenFile },
      ],
      connectTimeoutMs: 10,
      requestTimeoutMs: 99999,
      maxFrameBytes: 1,
    }, { homeDirectory, localAppData });
    assert.equal(config.endpoints.length, 2);
    assert.equal(config.connectTimeoutMs, 250);
    assert.equal(config.requestTimeoutMs, 5000);
    assert.equal(config.maxFrameBytes, 16384);
  });
});

test("Codex control rejects non-loopback URLs and paths outside fixed roots", () => {
  fixture(({ homeDirectory, localAppData, socketPath, tokenFile, root }) => {
    const base = { endpoints: [{ id: "ws", transport: "websocket", url: "ws://example.com:4500", tokenFile }] };
    assert.throws(() => validateCodexControlConfig(base, { homeDirectory, localAppData }), /loopback/);
    assert.throws(() => validateCodexControlConfig({ endpoints: [
      { id: "proxy", transport: "proxy", socketPath: path.join(root, "outside.sock") },
    ] }, { homeDirectory, localAppData }), /ENOENT|outside/);
    assert.throws(() => validateCodexControlConfig({ endpoints: [
      { id: "a", transport: "proxy", socketPath },
      { id: "a", transport: "websocket", url: "ws://127.0.0.1:4500", tokenFile },
    ] }, { homeDirectory, localAppData }), /unique/);
  });
});
