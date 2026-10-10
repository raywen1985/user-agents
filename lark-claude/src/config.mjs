import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(relativePath) {
  const fullPath = path.join(projectRoot, relativePath);
  return JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

function canonicalDirectory(inputPath) {
  if (!path.isAbsolute(inputPath)) throw new Error(`Project path must be absolute: ${inputPath}`);
  const resolved = fs.realpathSync.native(inputPath);
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`Project path is not a directory: ${resolved}`);
  return path.resolve(resolved);
}

function pathsOverlap(left, right) {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  if (a === b) return true;
  const relativeAB = path.relative(a, b);
  const relativeBA = path.relative(b, a);
  const within = (value) => value !== "" && !value.startsWith("..") && !path.isAbsolute(value);
  return within(relativeAB) || within(relativeBA);
}

export function loadConfig() {
  const gateway = readJson("config/gateway.json");
  const rawProjects = readJson("config/projects.json").projects;
  if (!Array.isArray(gateway.allowedOpenIds) || gateway.allowedOpenIds.length === 0) {
    throw new Error("allowedOpenIds must contain at least one open_id");
  }
  for (const [name, executable] of Object.entries(gateway.executables || {})) {
    if (!path.isAbsolute(executable) || !fs.existsSync(executable)) {
      throw new Error(`Executable ${name} was not found: ${executable}`);
    }
  }

  const aliases = new Map();
  const projects = rawProjects.map((project) => {
    const canonicalPath = canonicalDirectory(project.path);
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
      if (pathsOverlap(projects[i].path, projects[j].path)) {
        throw new Error(`Project roots overlap: ${projects[i].path} and ${projects[j].path}`);
      }
    }
  }

  return { gateway, projects, projectAliases: aliases };
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
  if (!alias) return config.projects.length === 1 ? config.projects[0] : null;
  return config.projectAliases.get(String(alias).trim().toLowerCase()) || null;
}
