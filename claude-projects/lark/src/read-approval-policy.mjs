import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decodeCanonicalShlex13 } from "./shlex-1.3.mjs";

const MAX_COMMAND_BYTES = 8192;
const MAX_SCRIPT_BYTES = 4096;
const MAX_ARG_BYTES = 4096;
const MAX_ARGV = 8;
const MAX_INPUT_BYTES = 16384;
const MAX_OUTPUT_BYTES = 4096;
const ANALYZER_TIMEOUT_MS = 2000;
const SVN_VALIDATOR_TIMEOUT_MS = 30000;

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function canonicalRegularFile(file) {
  const resolved = fs.realpathSync.native(file);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Protected path is not a regular file: ${file}`);
  let current = resolved;
  while (true) {
    const info = fs.lstatSync(current);
    if (info.isSymbolicLink()) throw new Error(`Protected path uses a reparse link: ${file}`);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolved;
}

function canonicalExistingAncestor(candidate) {
  let current = path.resolve(candidate);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error("No existing ancestor");
    current = parent;
  }
  return fs.realpathSync.native(current);
}

function normalize(value) {
  return path.resolve(value).toLowerCase();
}

function canonicalComparable(value) {
  try { return normalize(fs.existsSync(value) ? fs.realpathSync.native(value) : value); } catch { return normalize(value); }
}

function findOnPath(name, env = process.env) {
  for (const directory of String(env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory.replace(/^"|"$/g, ""), name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function profilePaths(host, env = process.env) {
  const home = env.USERPROFILE || os.homedir();
  const documents = path.join(home, "Documents");
  const hostDirectory = path.dirname(host);
  const windowsPowerShell = normalize(host).includes("\\windowspowershell\\");
  const userDirectory = path.join(documents, windowsPowerShell ? "WindowsPowerShell" : "PowerShell");
  return [
    path.join(hostDirectory, "profile.ps1"),
    path.join(hostDirectory, "Microsoft.PowerShell_profile.ps1"),
    path.join(userDirectory, "profile.ps1"),
    path.join(userDirectory, "Microsoft.PowerShell_profile.ps1"),
  ].map((profile) => path.resolve(profile));
}

function discoverProfilePaths(host, spawnSyncImpl = spawnSync) {
  const source = "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $p=$PROFILE; @($p.AllUsersAllHosts,$p.AllUsersCurrentHost,$p.CurrentUserAllHosts,$p.CurrentUserCurrentHost) | ConvertTo-Json -Compress";
  const result = spawnSyncImpl(host, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", source], {
    windowsHide: true,
    encoding: "utf8",
    timeout: ANALYZER_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  if (result.error || result.status !== 0 || result.stderr || typeof result.stdout !== "string") throw new Error("PowerShell profile discovery failed");
  const parsed = JSON.parse(result.stdout);
  if (!Array.isArray(parsed) || parsed.length !== 4 || parsed.some((value) => typeof value !== "string" || !path.isAbsolute(value))) {
    throw new Error("PowerShell profile discovery returned invalid paths");
  }
  return parsed.map((profile) => path.resolve(profile));
}

function validateResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).sort().join(",") !== "action,reason,safe,version" || value.version !== 1 || typeof value.safe !== "boolean") return null;
  const safe = new Map([
    ["safe_read", "read"], ["safe_list", "listFiles"], ["safe_test", "test"],
    ["safe_resolve", "resolve"], ["safe_conditional", "conditional"],
    ["svn_status", "svnStatus"], ["svn_revert", "svnRevert"],
  ]);
  if (safe.has(value.reason)) {
    const action = value.action;
    if (!value.safe || !action || typeof action !== "object" || Array.isArray(action)
      || Object.keys(action).sort().join(",") !== "kind,path" || action.kind !== safe.get(value.reason)
      || (action.path !== null && typeof action.path !== "string")) return null;
    return value;
  }
  if (!["invalid_request", "parse_error", "unsupported_ast", "unsafe_path"].includes(value.reason)
    || value.safe || value.action !== null) return null;
  return value;
}

function runAnalyzer({ executable, analyzer, projectRoot, svnExecutable, request, spawnImpl = spawn }) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child;
    try {
      child = spawnImpl(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", analyzer,
        "-ProjectRoot", projectRoot, "-SvnExecutable", svnExecutable], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch { resolve(null); return; }
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      setTimeout(() => finish(null), 250).unref?.();
    }, ANALYZER_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.on("data", (chunk) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length > MAX_OUTPUT_BYTES) { try { child.kill(); } catch {}; finish(null); }
    });
    child.stderr.on("data", (chunk) => {
      stderr = Buffer.concat([stderr, chunk]);
      if (stderr.length > 0) { try { child.kill(); } catch {}; finish(null); }
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      if (code !== 0 || stderr.length || stdout.length > MAX_OUTPUT_BYTES) { finish(null); return; }
      const text = stdout.toString("utf8");
      if (!text.endsWith("\n") || text.trim().split(/\r?\n/).length !== 1) { finish(null); return; }
      try { finish(validateResult(JSON.parse(text))); } catch { finish(null); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

function validateSvnResult(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === "reason,safe,version"
    && value.version === 1 && typeof value.safe === "boolean" && typeof value.reason === "string"
    ? value : null;
}

function runSvnValidator({ executable, validator, projectRoot, svnExecutable, request, spawnImpl = spawn }) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child;
    try {
      child = spawnImpl(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", validator,
        "-ProjectRoot", projectRoot, "-SvnExecutable", svnExecutable], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch { resolve(null); return; }
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      setTimeout(() => finish(null), 250).unref?.();
    }, SVN_VALIDATOR_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.on("data", (chunk) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length > MAX_OUTPUT_BYTES) { try { child.kill(); } catch {}; finish(null); }
    });
    child.stderr.on("data", (chunk) => {
      stderr = Buffer.concat([stderr, chunk]);
      if (stderr.length > 0) { try { child.kill(); } catch {}; finish(null); }
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      if (code !== 0 || stderr.length || stdout.length > MAX_OUTPUT_BYTES) { finish(null); return; }
      const text = stdout.toString("utf8");
      if (!text.endsWith("\n") || text.trim().split(/\r?\n/).length !== 1) { finish(null); return; }
      try { finish(validateSvnResult(JSON.parse(text))); } catch { finish(null); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

const NO_OPERATION = Object.freeze({ autoApprove: false, operationClass: null, grantEligible: false });

export class ReadApprovalPolicy {
  constructor({ projectRoots = [], analyzerPath, svnValidatorPath, svnPath, powershellPath, pwshPath = null, spawnImpl = spawn, spawnSyncImpl = spawnSync }) {
    this.projectRoots = projectRoots.map((root) => fs.realpathSync.native(root));
    this.spawnImpl = spawnImpl;
    this.disabled = false;
    this.protected = new Map();
    this.hosts = new Map();
    this.hostProfiles = new Map();
    this.profiles = new Set();
    try {
      this.analyzerPath = canonicalRegularFile(analyzerPath);
      this.svnValidatorPath = canonicalRegularFile(svnValidatorPath);
      this.svnExecutable = canonicalRegularFile(svnPath);
      this.analyzerHost = canonicalRegularFile(powershellPath);
      const hosts = [powershellPath, pwshPath].filter(Boolean);
      for (const candidate of hosts) {
        const host = canonicalRegularFile(candidate);
        const hostKey = normalize(host);
        this.hosts.set(hostKey, host);
        const discovered = discoverProfilePaths(host, spawnSyncImpl);
        const fixed = normalize(host).includes("\\windowspowershell\\") ? profilePaths(host) : [];
        const profiles = [...new Set([...discovered, ...fixed].map((profile) => normalize(profile)))];
        this.hostProfiles.set(hostKey, profiles);
        for (const profile of profiles) this.profiles.add(profile);
      }
      for (const file of [this.analyzerPath, this.svnValidatorPath, this.svnExecutable, ...this.hosts.values()]) {
        this.protected.set(normalize(file), { file, digest: sha256(file) });
      }
      for (const key of this.profiles) this.protected.set(key, { file: key, digest: null, profile: true });
      for (const entry of this.protected.values()) {
        if (this.projectRoots.some((root) => isWithin(root, entry.file))) this.disabled = true;
      }
    } catch {
      this.disabled = true;
    }
  }

  static create({ projectRoots, svnPath, env = process.env, spawnImpl = spawn, spawnSyncImpl = spawnSync } = {}) {
    const analyzerPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "classify-read-command.ps1");
    const svnValidatorPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "validate-svn-revert.ps1");
    const systemRoot = env.SystemRoot || env.SYSTEMROOT;
    if (!systemRoot || !path.isAbsolute(systemRoot)) {
      return new ReadApprovalPolicy({
        projectRoots, analyzerPath, svnValidatorPath, svnPath,
        powershellPath: "", pwshPath: null, spawnImpl, spawnSyncImpl,
      });
    }
    const powershellPath = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return new ReadApprovalPolicy({
      projectRoots,
      analyzerPath,
      svnValidatorPath,
      svnPath,
      powershellPath,
      pwshPath: findOnPath("pwsh.exe", env),
      spawnImpl,
      spawnSyncImpl,
    });
  }

  isProtectedPath(candidate) {
    return this.protected.has(normalize(candidate));
  }

  verifyProtectedFiles() {
    if (this.disabled) return false;
    try {
      for (const entry of this.protected.values()) {
        if (entry.profile) continue;
        const current = canonicalRegularFile(entry.file);
        if (normalize(current) !== normalize(entry.file) || sha256(current) !== entry.digest) return false;
      }
      return true;
    } catch { return false; }
  }

  isProjectRootSafe(projectRoot) {
    try {
      const root = fs.realpathSync.native(projectRoot);
      return [...this.protected.values()].every((entry) => !isWithin(root, entry.file));
    } catch { return false; }
  }

  profilesAbsent(hostKey) {
    try {
      const profiles = this.hostProfiles.get(hostKey);
      if (!profiles) return false;
      for (const profile of profiles) {
        if (fs.existsSync(profile)) return false;
        canonicalExistingAncestor(profile);
      }
      return true;
    } catch { return false; }
  }

  validatePath(projectRoot, cwd, literal, { allowAbsent = false } = {}) {
    if (literal === null) return null;
    const candidate = path.resolve(cwd, literal);
    if (!allowAbsent && !fs.existsSync(candidate)) return null;
    try {
      const canonical = fs.existsSync(candidate) ? fs.realpathSync.native(candidate) : canonicalExistingAncestor(candidate);
      return isWithin(projectRoot, canonical) ? candidate : null;
    } catch { return null; }
  }

  classifyTrustedPowerShellHost(params) {
    if (typeof params?.command !== "string" || Buffer.byteLength(params.command) > MAX_COMMAND_BYTES) return null;
    const argv = decodeCanonicalShlex13(params.command);
    if (!argv?.length) return null;
    const hostKey = normalize(argv[0]);
    const host = this.hosts.get(hostKey);
    const protectedHost = this.protected.get(hostKey);
    if (!host || !protectedHost || protectedHost.profile) return null;
    try {
      const current = canonicalRegularFile(host);
      if (normalize(current) !== hostKey || sha256(current) !== protectedHost.digest) return null;
      return Object.freeze({ trustedPowerShellHost: true, executable: host });
    } catch {
      return null;
    }
  }

  async classify(params, projectRoot) {
    return (await this.classifyOperation(params, projectRoot)).autoApprove;
  }

  async classifyOperation(params, projectRoot) {
    if (!this.verifyProtectedFiles() || !this.isProjectRootSafe(projectRoot)
      || params?.kind && params.kind !== "command" || params?.networkApprovalContext || params?.additionalPermissions) return NO_OPERATION;
    if (typeof params?.command !== "string" || Buffer.byteLength(params.command) > MAX_COMMAND_BYTES
      || !Array.isArray(params.commandActions) || params.commandActions.length !== 1) return NO_OPERATION;
    const argv = decodeCanonicalShlex13(params.command);
    if (!argv || argv.length > MAX_ARGV || argv.some((arg) => Buffer.byteLength(arg) > MAX_ARG_BYTES)) return NO_OPERATION;
    const hostKey = normalize(argv[0] || "");
    const host = this.hosts.get(hostKey);
    if (!host) return NO_OPERATION;
    let index = 1;
    if (argv[index] === "-NoLogo") index += 1;
    const noProfile = argv[index] === "-NoProfile";
    if (noProfile) index += 1;
    if (argv[index] === "-NonInteractive") index += 1;
    if (argv[index] !== "-Command" || index + 2 !== argv.length) return NO_OPERATION;
    if (!noProfile && !this.profilesAbsent(hostKey)) return NO_OPERATION;
    const script = argv[index + 1];
    if (Buffer.byteLength(script) > MAX_SCRIPT_BYTES) return NO_OPERATION;
    const action = params.commandActions[0];
    if (!action || typeof action.command !== "string" || action.command !== script) return NO_OPERATION;
    const root = fs.realpathSync.native(projectRoot);
    const cwd = params.cwd || root;
    let canonicalCwd;
    try { canonicalCwd = fs.realpathSync.native(cwd); } catch { return NO_OPERATION; }
    if (!isWithin(root, canonicalCwd)) return NO_OPERATION;
    const request = { version: 1, script, cwd: canonicalCwd };
    if (Buffer.byteLength(JSON.stringify(request)) > MAX_INPUT_BYTES) return NO_OPERATION;
    const result = await runAnalyzer({ executable: this.analyzerHost,
      analyzer: this.analyzerPath, projectRoot: root, svnExecutable: this.svnExecutable,
      request, spawnImpl: this.spawnImpl });
    if (!result?.safe) return NO_OPERATION;
    const resolved = this.validatePath(root, canonicalCwd, result.action.path, {
      allowAbsent: ["conditional", "test", "svnRevert"].includes(result.action.kind),
    });
    if (result.action.path !== null && !resolved) return NO_OPERATION;
    if (result.action.kind === "svnStatus") {
      return action.type === "unknown" && !Object.hasOwn(action, "path")
        ? Object.freeze({ autoApprove: true, operationClass: "svn-status", grantEligible: true }) : NO_OPERATION;
    }
    if (result.action.kind === "svnRevert") {
      if (action.type !== "unknown" || Object.hasOwn(action, "path")) return NO_OPERATION;
      const validationRequest = {
        version: 1,
        cwd: canonicalCwd,
        target: result.action.path,
        protectedPaths: [...this.protected.values()].map((entry) => entry.file),
      };
      if (Buffer.byteLength(JSON.stringify(validationRequest)) > 32768) return NO_OPERATION;
      const validation = await runSvnValidator({
        executable: this.analyzerHost,
        validator: this.svnValidatorPath,
        projectRoot: root,
        svnExecutable: this.svnExecutable,
        request: validationRequest,
        spawnImpl: this.spawnImpl,
      });
      return validation?.safe
        ? Object.freeze({ autoApprove: false, operationClass: "svn-revert", grantEligible: true })
        : NO_OPERATION;
    }
    if (result.action.kind === "read") return action.type === "read" && typeof action.path === "string"
      && canonicalComparable(action.path) === canonicalComparable(resolved)
      ? Object.freeze({ autoApprove: true, operationClass: null, grantEligible: false }) : NO_OPERATION;
    if (result.action.kind === "listFiles") {
      if (action.type !== "listFiles") return NO_OPERATION;
      const valid = result.action.path === null ? action.path === null || action.path === undefined
        : typeof action.path === "string" && canonicalComparable(path.resolve(canonicalCwd, action.path)) === canonicalComparable(resolved);
      return valid ? Object.freeze({ autoApprove: true, operationClass: null, grantEligible: false }) : NO_OPERATION;
    }
    return result.action.kind === "conditional" && action.type === "unknown" && !Object.hasOwn(action, "path")
      ? Object.freeze({ autoApprove: true, operationClass: null, grantEligible: false }) : NO_OPERATION;
  }
}

export function isSafeFileChange(item, projectPath, protectedPolicy = null) {
  if (!item || item.type !== "fileChange" || !Array.isArray(item.changes) || item.changes.length === 0) return false;
  let canonicalRoot;
  try { canonicalRoot = fs.realpathSync.native(projectPath); } catch { return false; }
  return item.changes.every((change) => {
    if (change.kind?.type === "delete" || change.kind === "delete" || protectedPolicy?.isProtectedPath(change.path)) return false;
    try {
      const canonical = fs.existsSync(change.path) ? fs.realpathSync.native(change.path) : canonicalExistingAncestor(change.path);
      return isWithin(canonicalRoot, canonical);
    } catch { return false; }
  });
}
