import fs from "node:fs";
import path from "node:path";
import { runProcess } from "./process-utils.mjs";

const PREFLIGHT_TIMEOUT_MS = 5000;
const MAX_DIAGNOSTICS = 12;
const NPM_LAYOUTS = {
  x64: ["codex-win32-x64", "x86_64-pc-windows-msvc"],
  arm64: ["codex-win32-arm64", "aarch64-pc-windows-msvc"],
};

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorReason(error) {
  const code = error?.code ? `${error.code}: ` : "";
  return `${code}${error?.message || String(error)}`.replace(/[\r\n]+/g, " ").slice(0, 300);
}

function record(diagnostics, message) {
  if (diagnostics.length < MAX_DIAGNOSTICS) diagnostics.push(message);
}

function isWithin(root, candidate) {
  const relative = path.relative(root.toLowerCase(), candidate.toLowerCase());
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function fingerprint(candidate) {
  return `${candidate.size}:${candidate.mtimeMs}`;
}

export function validateCodexExecutableConfig(value) {
  if (value === "auto") return;
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error("Executable codex must be an absolute codex.exe path or the string 'auto'");
  }
  if (path.basename(value).toLowerCase() !== "codex.exe") {
    throw new Error(`Executable codex must name codex.exe: ${value}`);
  }
}

function inspectFile(fsImpl, candidatePath, diagnostics, { root, label }) {
  try {
    const lexicalPath = path.resolve(candidatePath);
    if (path.basename(lexicalPath).toLowerCase() !== "codex.exe") {
      record(diagnostics, `${label}: rejected non-codex executable ${lexicalPath}`);
      return null;
    }
    const lexicalStat = fsImpl.lstatSync(lexicalPath);
    if (lexicalStat.isSymbolicLink() || !lexicalStat.isFile()) {
      record(diagnostics, `${label}: rejected non-regular or linked file ${lexicalPath}`);
      return null;
    }
    const canonicalPath = fsImpl.realpathSync.native(lexicalPath);
    if (root && !isWithin(root, canonicalPath)) {
      record(diagnostics, `${label}: canonical path escaped discovery root ${lexicalPath}`);
      return null;
    }
    const stat = fsImpl.statSync(canonicalPath);
    if (!stat.isFile()) {
      record(diagnostics, `${label}: canonical target is not a regular file ${canonicalPath}`);
      return null;
    }
    return {
      executable: path.resolve(canonicalPath),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      source: label,
    };
  } catch (error) {
    record(diagnostics, `${label}: ${candidatePath}: ${errorReason(error)}`);
    return null;
  }
}

function desktopCandidates(fsImpl, localAppData, diagnostics) {
  if (typeof localAppData !== "string" || !localAppData.trim()) {
    record(diagnostics, "desktop: LOCALAPPDATA is not set");
    return [];
  }
  const lexicalRoot = path.join(localAppData, "OpenAI", "Codex", "bin");
  let canonicalRoot;
  let entries;
  try {
    const rootStat = fsImpl.lstatSync(lexicalRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      record(diagnostics, `desktop: rejected non-directory or linked root ${lexicalRoot}`);
      return [];
    }
    canonicalRoot = fsImpl.realpathSync.native(lexicalRoot);
    entries = fsImpl.readdirSync(canonicalRoot, { withFileTypes: true });
  } catch (error) {
    record(diagnostics, `desktop: ${lexicalRoot}: ${errorReason(error)}`);
    return [];
  }

  const candidates = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const directory = path.join(canonicalRoot, entry.name);
    try {
      const directoryStat = fsImpl.lstatSync(directory);
      if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) continue;
    } catch (error) {
      record(diagnostics, `desktop: ${directory}: ${errorReason(error)}`);
      continue;
    }
    const candidate = inspectFile(fsImpl, path.join(directory, "codex.exe"), diagnostics, {
      root: canonicalRoot,
      label: "desktop",
    });
    if (candidate) candidates.push(candidate);
  }

  return candidates.sort((left, right) => {
    if (left.mtimeMs !== right.mtimeMs) return right.mtimeMs - left.mtimeMs;
    const lower = compareCodeUnits(left.executable.toLowerCase(), right.executable.toLowerCase());
    return lower || compareCodeUnits(left.executable, right.executable);
  });
}

function npmCandidate(fsImpl, appData, arch, diagnostics) {
  if (typeof appData !== "string" || !appData.trim()) {
    record(diagnostics, "npm: APPDATA is not set");
    return null;
  }
  const layout = NPM_LAYOUTS[arch];
  if (!layout) {
    record(diagnostics, `npm: unsupported architecture ${arch}`);
    return null;
  }
  const lexicalRoot = path.join(appData, "npm", "node_modules", "@openai");
  let canonicalRoot;
  try {
    const rootStat = fsImpl.lstatSync(lexicalRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      record(diagnostics, `npm: rejected non-directory or linked root ${lexicalRoot}`);
      return null;
    }
    canonicalRoot = fsImpl.realpathSync.native(lexicalRoot);
  } catch (error) {
    record(diagnostics, `npm: ${lexicalRoot}: ${errorReason(error)}`);
    return null;
  }
  const [packageName, target] = layout;
  const candidatePath = path.join(
    canonicalRoot,
    "codex",
    "node_modules",
    "@openai",
    packageName,
    "vendor",
    target,
    "bin",
    "codex.exe",
  );
  return inspectFile(fsImpl, candidatePath, diagnostics, { root: canonicalRoot, label: "npm" });
}

async function defaultPreflight(executable) {
  try {
    const result = await runProcess(executable, ["app-server", "--help"], {
      timeoutMs: PREFLIGHT_TIMEOUT_MS,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.code !== 0) return { ok: false, reason: `exit code ${result.code}` };
    if (!/Usage:\s+codex app-server/i.test(output)) {
      return { ok: false, reason: "app-server usage marker was not found" };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: errorReason(error) };
  }
}

export function createCodexExecutableResolver({
  configured,
  env = process.env,
  arch = process.arch,
  fsImpl = fs,
  preflight = defaultPreflight,
  onSelection = () => {},
} = {}) {
  validateCodexExecutableConfig(configured);
  const mode = configured === "auto" ? "auto" : "explicit";
  const preflightCache = new Map();
  const skipOnce = new Set();
  let lastSelection = "";

  async function accept(candidate, diagnostics) {
    const key = candidate.executable.toLowerCase();
    if (skipOnce.delete(key)) {
      record(diagnostics, `${candidate.source}: skipped invalidated candidate ${candidate.executable}`);
      return null;
    }
    const signature = fingerprint(candidate);
    if (preflightCache.get(key) !== signature) {
      let result;
      try {
        result = await preflight(candidate.executable, { timeoutMs: PREFLIGHT_TIMEOUT_MS });
      } catch (error) {
        result = { ok: false, reason: errorReason(error) };
      }
      if (!result?.ok) {
        record(diagnostics, `${candidate.source}: preflight failed for ${candidate.executable}: ${result?.reason || "unknown error"}`);
        return null;
      }
      preflightCache.set(key, signature);
    }
    const selection = { executable: candidate.executable, source: candidate.source };
    const selectionKey = `${selection.source}:${selection.executable.toLowerCase()}`;
    if (selectionKey !== lastSelection) {
      lastSelection = selectionKey;
      onSelection(selection);
    }
    return selection;
  }

  return {
    mode,
    invalidate(executable) {
      if (mode === "auto" && executable) {
        const key = path.resolve(executable).toLowerCase();
        skipOnce.add(key);
        preflightCache.delete(key);
      }
    },
    async resolve() {
      const diagnostics = [];
      if (mode === "explicit") {
        const candidate = inspectFile(fsImpl, configured, diagnostics, { root: null, label: "explicit" });
        const selection = candidate && await accept(candidate, diagnostics);
        if (selection) return selection;
        throw new Error(`Explicit Codex executable is not usable: ${diagnostics.join(" | ")}`);
      }

      for (const candidate of desktopCandidates(fsImpl, env.LOCALAPPDATA, diagnostics)) {
        const selection = await accept(candidate, diagnostics);
        if (selection) return selection;
      }
      const fallback = npmCandidate(fsImpl, env.APPDATA, arch, diagnostics);
      if (fallback) {
        const selection = await accept(fallback, diagnostics);
        if (selection) return selection;
      }
      throw new Error(`Codex executable auto-resolution failed: ${diagnostics.join(" | ")}`);
    },
  };
}
