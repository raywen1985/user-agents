import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateCodexExecutableConfig } from "./codex-executable.mjs";
import { canonicalProjectDirectory, projectPathsConflict } from "./project-policy.mjs";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(fullPath) {
  return JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

function readOptionalJson(fullPath) {
  try { return readJson(fullPath); } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

const GATEWAY_KEYS = new Set([
  "allowedOpenIds", "recipientOpenId", "maxConcurrentProjects", "routerModel", "workerModel",
  "routerTimeoutMs", "workerTimeoutMs", "summaryLength", "recentSessionLimit",
  "powershellApprovalMode", "claudeExecutionMode", "voice", "executables", "codexControl", "installationGeneration",
]);
const EXECUTABLE_KEYS = new Set(["node", "larkCli", "claude", "ffmpeg", "svn", "codex"]);
const VOICE_KEYS = new Set(["enabled", "echoTranscript", "engineType", "maxDurationMs", "maxBytes", "timeoutMs"]);
const PROJECT_POLICY_KEYS = new Set(["projects", "excludedRoots"]);

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function assertKnownKeys(value, allowed, label) {
  assertPlainObject(value, label);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`Unknown ${label} property: ${key}`);
    if (value[key] === null) throw new Error(`${label}.${key} must not be null`);
  }
}

export function mergeGatewayConfig(base, local = {}) {
  assertKnownKeys(base, GATEWAY_KEYS, "gateway config");
  assertKnownKeys(local, GATEWAY_KEYS, "local gateway config");
  const merged = { ...base };
  for (const [key, value] of Object.entries(local)) {
    if (key === "executables" || key === "voice") {
      assertPlainObject(base[key] || {}, `gateway config.${key}`);
      assertPlainObject(value, `local gateway config.${key}`);
      merged[key] = { ...(base[key] || {}), ...value };
    } else {
      merged[key] = value;
    }
  }
  assertKnownKeys(merged.executables || {}, EXECUTABLE_KEYS, "gateway config.executables");
  assertKnownKeys(merged.voice || {}, VOICE_KEYS, "gateway config.voice");
  if (merged.allowedOpenIds !== undefined && !Array.isArray(merged.allowedOpenIds)) {
    throw new Error("gateway config.allowedOpenIds must be an array");
  }
  return merged;
}

export function mergeProjectPolicy(base = {}, local = {}) {
  assertKnownKeys(base, PROJECT_POLICY_KEYS, "project policy");
  assertKnownKeys(local, PROJECT_POLICY_KEYS, "local project policy");
  const merged = { ...base, ...local };
  for (const key of PROJECT_POLICY_KEYS) {
    if (merged[key] !== undefined && !Array.isArray(merged[key])) throw new Error(`project policy.${key} must be an array`);
  }
  return merged;
}

function resolveConfiguredPath(inputPath, rootPath, label) {
  if (typeof inputPath !== "string" || !inputPath.trim()) throw new Error(`${label} is missing; run scripts/install-task.ps1`);
  const candidate = path.isAbsolute(inputPath) ? path.normalize(inputPath) : path.resolve(rootPath, inputPath);
  if (!path.isAbsolute(inputPath)) {
    const relative = path.relative(rootPath, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} escapes the project root: ${inputPath}`);
  }
  let canonical;
  try { canonical = fs.realpathSync.native(candidate); } catch {
    throw new Error(`${label} was not found: ${candidate}`);
  }
  if (!fs.lstatSync(canonical).isFile()) throw new Error(`${label} is not a regular file: ${canonical}`);
  return canonical;
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

const SPEECH_ENGINE_TYPES = new Set(["16k_auto"]);
const POWERSHELL_APPROVAL_MODES = new Set(["review", "always_allow"]);
const CLAUDE_EXECUTION_MODES = new Set(["restricted", "full_access"]);

export function validateClaudeExecutionMode(value) {
  const mode = value ?? "restricted";
  if (!CLAUDE_EXECUTION_MODES.has(mode)) throw new Error(`Unsupported Claude execution mode: ${mode}`);
  return mode;
}

export function validatePowerShellApprovalMode(value) {
  const mode = value == null ? "review" : String(value);
  if (!POWERSHELL_APPROVAL_MODES.has(mode)) throw new Error(`Unsupported PowerShell approval mode: ${mode}`);
  return mode;
}

export function validateVoiceConfig(input) {
  if (input == null) input = {};
  if (typeof input !== "object" || Array.isArray(input)) throw new Error("gateway.voice is invalid");
  const engineType = input.engineType == null ? "16k_auto" : String(input.engineType);
  if (!SPEECH_ENGINE_TYPES.has(engineType)) throw new Error(`Unsupported voice engine type: ${engineType}`);
  return Object.freeze({
    enabled: input.enabled !== false,
    echoTranscript: input.echoTranscript !== false,
    engineType,
    maxDurationMs: boundedNumber(input.maxDurationMs, 60000, 1000, 3600000),
    maxBytes: boundedNumber(input.maxBytes, 10 * 1024 * 1024, 1024, 20 * 1024 * 1024),
    timeoutMs: boundedNumber(input.timeoutMs, 60000, 5000, 120000),
  });
}

export function loadConfig({ rootPath = projectRoot, configDirectory = path.join(rootPath, "config") } = {}) {
  const gateway = mergeGatewayConfig(
    readJson(path.join(configDirectory, "gateway.json")),
    readOptionalJson(path.join(configDirectory, "gateway.local.json")),
  );
  const projectPolicy = mergeProjectPolicy(
    readOptionalJson(path.join(configDirectory, "projects.json")),
    readOptionalJson(path.join(configDirectory, "projects.local.json")),
  );
  const rawProjects = projectPolicy.projects || [];
  const rawExcludedRoots = projectPolicy.excludedRoots || [];
  if (!Array.isArray(rawProjects) || !Array.isArray(rawExcludedRoots)) throw new Error("Project policy arrays are invalid");
  if (!Array.isArray(gateway.allowedOpenIds) || gateway.allowedOpenIds.length === 0) {
    throw new Error("allowedOpenIds must contain at least one open_id");
  }
  gateway.executables ||= {};
  gateway.executables.codex ??= "auto";
  validateCodexExecutableConfig(gateway.executables.codex);
  gateway.codexControl = validateCodexControlConfig(gateway.codexControl);
  gateway.voice = validateVoiceConfig(gateway.voice);
  gateway.powershellApprovalMode = validatePowerShellApprovalMode(gateway.powershellApprovalMode);
  gateway.claudeExecutionMode = validateClaudeExecutionMode(gateway.claudeExecutionMode);
  for (const [name, executable] of Object.entries(gateway.executables || {})) {
    if (name === "codex") continue;
    gateway.executables[name] = resolveConfiguredPath(executable, rootPath, `Executable ${name}`);
  }
  for (const name of ["node", "larkCli", "claude", "ffmpeg", "svn"]) {
    if (!gateway.executables[name]) throw new Error(`Executable ${name} is missing; run scripts/install-task.ps1`);
  }
  if (gateway.installationGeneration !== undefined
    && !/^[a-f0-9]{32}$/i.test(String(gateway.installationGeneration))) {
    throw new Error("gateway.installationGeneration is invalid");
  }

  const aliases = new Map();
  const projects = rawProjects.map((project) => {
    const configuredPath = path.isAbsolute(project.path) ? project.path : path.resolve(rootPath, project.path);
    if (!path.isAbsolute(project.path)) {
      const relative = path.relative(rootPath, configuredPath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Project path escapes the project root: ${project.path}`);
    }
    const canonicalPath = canonicalProjectDirectory(configuredPath);
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

  const excludedRoots = rawExcludedRoots.map((root) => {
    const configuredRoot = path.isAbsolute(root) ? root : path.resolve(rootPath, root);
    if (!path.isAbsolute(root)) {
      const relative = path.relative(rootPath, configuredRoot);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Excluded root escapes the project root: ${root}`);
    }
    return canonicalProjectDirectory(configuredRoot);
  });
  for (const project of projects) {
    if (excludedRoots.some((root) => projectPathsConflict(root, project.path))) {
      throw new Error(`Project override overlaps an excluded root: ${project.path}`);
    }
  }

  return { gateway, projects, projectAliases: aliases, excludedRoots };
}

export function loadClaudeEnvironment({
  executionMode = "restricted",
  inheritedEnv = process.env,
  settingsPath = path.join(inheritedEnv.USERPROFILE || "", ".claude", "settings.json"),
} = {}) {
  const fullAccess = validateClaudeExecutionMode(executionMode) === "full_access";
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const inheritedKeys = ["PATH", "PATHEXT", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "COMSPEC"];
  const env = fullAccess ? { ...inheritedEnv } : {};
  for (const key of inheritedKeys) {
    if (inheritedEnv[key] !== undefined) env[key] = inheritedEnv[key];
  }
  for (const [key, value] of Object.entries(settings.env || {})) {
    if (fullAccess || key.startsWith("ANTHROPIC_") || key === "API_TIMEOUT_MS" || key === "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC") {
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
