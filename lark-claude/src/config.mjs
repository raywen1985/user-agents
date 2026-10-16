import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateCodexExecutableConfig } from "./codex-executable.mjs";
import { canonicalProjectDirectory, projectPathsConflict } from "./project-policy.mjs";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(relativePath) {
  const fullPath = path.join(projectRoot, relativePath);
  return JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

function boundedNumber(value, fallback, minimum, maximum) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(minimum, Math.min(maximum, Math.trunc(numeric))) : fallback;
}

function canonicalFileWithin(inputPath, rootPath, { maxBytes = null, requireFile = false } = {}) {
  if (typeof inputPath !== "string" || !path.isAbsolute(inputPath)) throw new Error(`Control path must be absolute: ${inputPath}`);
  const inputStat = fs.lstatSync(inputPath);
  const rootStat = fs.lstatSync(rootPath);
  if (inputStat.isSymbolicLink() || rootStat.isSymbolicLink()) throw new Error(`Control path must not be a reparse link: ${inputPath}`);
  const root = fs.realpathSync.native(rootPath);
  const resolved = fs.realpathSync.native(inputPath);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink()) throw new Error(`Control path must not be a reparse link: ${resolved}`);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Control path is outside its fixed root: ${resolved}`);
  if (requireFile && !stat.isFile()) throw new Error(`Control path must be a regular file: ${resolved}`);
  if (maxBytes !== null && stat.size > maxBytes) throw new Error(`Control file is too large: ${resolved}`);
  return resolved;
}

export function validateCodexControlConfig(input, {
  homeDirectory = process.env.USERPROFILE || "",
  localAppData = process.env.LOCALAPPDATA || "",
} = {}) {
  if (input == null) return Object.freeze({ endpoints: Object.freeze([]), connectTimeoutMs: 1000, requestTimeoutMs: 2000, maxFrameBytes: 262144 });
  if (!input || typeof input !== "object" || !Array.isArray(input.endpoints) || input.endpoints.length > 4) {
    throw new Error("gateway.codexControl endpoints are invalid");
  }
  const ids = new Set();
  const endpoints = input.endpoints.map((endpoint) => {
    if (!endpoint || typeof endpoint !== "object" || typeof endpoint.id !== "string" || !endpoint.id.trim() || ids.has(endpoint.id)) {
      throw new Error("Codex control endpoint IDs must be non-empty and unique");
    }
    ids.add(endpoint.id);
    if (endpoint.transport === "proxy") {
      const socketRoot = path.join(homeDirectory, ".codex", "app-server-control");
      const socketPath = canonicalFileWithin(endpoint.socketPath, socketRoot);
      return Object.freeze({ id: endpoint.id, transport: "proxy", socketPath });
    }
    if (endpoint.transport === "websocket") {
      let url;
      try { url = new URL(endpoint.url); } catch { throw new Error(`Invalid Codex control WebSocket URL: ${endpoint.url}`); }
      if (url.protocol !== "ws:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || !url.port
        || url.username || url.password || url.search || url.hash) {
        throw new Error(`Codex control WebSocket must be an explicit loopback ws URL: ${endpoint.url}`);
      }
      const secretRoot = path.join(localAppData, "lark-claude", "secrets");
      const tokenFile = canonicalFileWithin(endpoint.tokenFile, secretRoot, { maxBytes: 4096, requireFile: true });
      return Object.freeze({ id: endpoint.id, transport: "websocket", url: url.toString(), tokenFile });
    }
    throw new Error(`Unsupported Codex control transport: ${endpoint.transport}`);
  });
  return Object.freeze({
    endpoints: Object.freeze(endpoints),
    connectTimeoutMs: boundedNumber(input.connectTimeoutMs, 1000, 250, 5000),
    requestTimeoutMs: boundedNumber(input.requestTimeoutMs, 2000, 250, 5000),
    maxFrameBytes: boundedNumber(input.maxFrameBytes, 262144, 16384, 524288),
  });
}

export function loadConfig() {
  const gateway = readJson("config/gateway.json");
  let projectPolicy = {};
  try { projectPolicy = readJson("config/projects.json"); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const rawProjects = projectPolicy.projects || [];
  const rawExcludedRoots = projectPolicy.excludedRoots || [];
  if (!Array.isArray(rawProjects) || !Array.isArray(rawExcludedRoots)) throw new Error("Project policy arrays are invalid");
  if (!Array.isArray(gateway.allowedOpenIds) || gateway.allowedOpenIds.length === 0) {
    throw new Error("allowedOpenIds must contain at least one open_id");
  }
  validateCodexExecutableConfig(gateway.executables?.codex);
  gateway.codexControl = validateCodexControlConfig(gateway.codexControl);
  for (const [name, executable] of Object.entries(gateway.executables || {})) {
    if (name === "codex") continue;
    if (typeof executable !== "string" || !path.isAbsolute(executable) || !fs.existsSync(executable)) {
      throw new Error(`Executable ${name} was not found: ${executable}`);
    }
  }

  const aliases = new Map();
  const projects = rawProjects.map((project) => {
    const canonicalPath = canonicalProjectDirectory(project.path);
    const normalized = { ...project, path: canonicalPath };
    for (const alias of [project.alias, ...(project.aliases || [])]) {
      const key = String(alias).trim().toLowerCase();
      if (!key || aliases.has(key)) throw new Error(`Duplicate project alias: ${alias}`);
      aliases.set(key, normalized);
    }
    return normalized;
  });

  for (let i = 0; i < projects.length; i += 1) {
    for (let j = i + 1; j < projects.length; j += 1) {
      if (projectPathsConflict(projects[i].path, projects[j].path)) {
        throw new Error(`Project roots overlap: ${projects[i].path} and ${projects[j].path}`);
      }
    }
  }

  const excludedRoots = rawExcludedRoots.map(canonicalProjectDirectory);
  for (const project of projects) {
    if (excludedRoots.some((root) => projectPathsConflict(root, project.path))) {
      throw new Error(`Project override overlaps an excluded root: ${project.path}`);
    }
  }

  return { gateway, projects, projectAliases: aliases, excludedRoots };
}

export function loadClaudeEnvironment() {
  const settingsPath = path.join(process.env.USERPROFILE || "", ".claude", "settings.json");
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const inheritedKeys = ["PATH", "PATHEXT", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "COMSPEC"];
  const env = {};
  for (const key of inheritedKeys) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(settings.env || {})) {
    if (key.startsWith("ANTHROPIC_") || key === "API_TIMEOUT_MS" || key === "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC") {
      env[key] = String(value);
    }
  }
  env.LARK_GATEWAY_MANAGED = "1";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  return env;
}

export function loadChildEnvironment(extra = {}) {
  const inheritedKeys = [
    "PATH", "PATHEXT", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP",
    "USERPROFILE", "LOCALAPPDATA", "APPDATA", "COMSPEC", "HOMEDRIVE", "HOMEPATH",
  ];
  const env = {};
  for (const key of inheritedKeys) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.LARK_GATEWAY_MANAGED = "1";
  env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER = "1";
  env.LARKSUITE_CLI_NO_SKILLS_NOTIFIER = "1";
  return { ...env, ...extra };
}

export function resolveProject(config, alias) {
  if (!alias) return null;
  return config.projectAliases.get(String(alias).trim().toLowerCase()) || null;
}
