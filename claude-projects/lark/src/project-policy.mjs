import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

function normalizePath(value) {
  const resolved = path.resolve(value).replaceAll("/", "\\");
  const parsedRoot = path.parse(resolved).root.replaceAll("/", "\\");
  return (resolved.toLowerCase() === parsedRoot.toLowerCase()
    ? parsedRoot
    : resolved.replace(/\\+$/, "")).toLowerCase();
}

export function isPathWithin(root, candidate) {
  const base = normalizePath(root);
  const target = normalizePath(candidate);
  if (base === target) return true;
  const relative = path.relative(base, target);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function projectPathsConflict(left, right) {
  return isPathWithin(left, right) || isPathWithin(right, left);
}

function rejectReparseChain(inputPath) {
  const resolved = path.resolve(inputPath);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Project path must not contain a reparse point: ${inputPath}`);
  }
}

export function canonicalProjectDirectory(inputPath) {
  if (typeof inputPath !== "string" || !path.isAbsolute(inputPath)) {
    throw new Error(`Project path must be absolute: ${inputPath}`);
  }
  rejectReparseChain(inputPath);
  const resolved = fs.realpathSync.native(inputPath);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Project path is not a directory: ${resolved}`);
  return path.resolve(resolved);
}

export function projectKey(value) {
  return normalizePath(value);
}

export function isExcludedProject(config, projectPath) {
  return (config.excludedRoots || []).some((root) => isPathWithin(root, projectPath));
}

export function configuredProjectForPath(config, projectPath) {
  const key = projectKey(projectPath);
  return (config.projects || []).find((project) => projectKey(project.path) === key) || null;
}

function derivedAlias(projectPath) {
  const leaf = path.basename(projectPath) || "project";
  const digest = createHash("sha256").update(projectKey(projectPath)).digest("hex").slice(0, 8);
  return `${leaf}#${digest}`;
}

export function projectFromPath(config, projectPath, authorities = [], updatedAt = null) {
  const canonical = canonicalProjectDirectory(projectPath);
  if (isExcludedProject(config, canonical)) return null;
  const override = configuredProjectForPath(config, canonical);
  const label = override?.alias || path.basename(canonical) || canonical;
  return Object.freeze({
    alias: override?.alias || derivedAlias(canonical),
    label,
    display: label,
    aliases: Object.freeze([...new Set([label, ...(override?.aliases || [])].filter(Boolean))]),
    path: canonical,
    key: projectKey(canonical),
    authorities: Object.freeze(authorities.map((item) => Object.freeze({ ...item }))),
    updatedAt: Number(updatedAt || 0) || null,
  });
}

export function normalizeProjectQuery(value) {
  if (value == null) return null;
  const source = String(value).normalize("NFKC").trim();
  if (!source || [...source].length > 80 || /[\p{Cc}\p{Cs}]/u.test(source)) return null;
  if (path.isAbsolute(source) || /[\\/]/.test(source) || /^[a-z]:/i.test(source)) return null;
  return source.toLowerCase();
}

export function matchProjects(queryValue, projects) {
  const query = normalizeProjectQuery(queryValue);
  if (!query) return queryValue == null ? { kind: "all", projects } : { kind: "invalid", projects: [] };
  const matches = projects.filter((project) => [project.label, project.alias, ...(project.aliases || [])]
    .some((alias) => String(alias).normalize("NFKC").trim().toLowerCase() === query));
  if (matches.length === 0) return { kind: "none", projects: [] };
  if (matches.length === 1) return { kind: "selected", project: matches[0], projects: matches };
  return { kind: "selection", projects: matches };
}

export function finalizeProjectDisplays(projects) {
  const counts = new Map();
  for (const project of projects) counts.set(project.label.toLowerCase(), (counts.get(project.label.toLowerCase()) || 0) + 1);
  return projects.map((project) => Object.freeze({
    ...project,
    display: counts.get(project.label.toLowerCase()) > 1 ? `${project.label} | ${project.path}` : project.label,
  }));
}
