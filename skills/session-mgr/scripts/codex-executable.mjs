import fs from 'node:fs/promises';
import path from 'node:path';
import { fail } from './claude-reader.mjs';

const envValue = (env, name) => Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];

// Returns the same spawn invocation for production and installation probes.
export async function resolveCodexExecutable({ codexBin, env = process.env, args = [] } = {}) {
  const windows = process.platform === 'win32';
  const requested = codexBin || env.CODEX_APP_RUNTIME_CLI_PATH || 'codex';
  const explicit = Boolean(codexBin || env.CODEX_APP_RUNTIME_CLI_PATH);
  const hasPath = path.isAbsolute(requested) || /[\\/]/.test(requested);
  const directories = hasPath ? [''] : String(envValue(env, 'PATH') || '').split(path.delimiter).filter(Boolean).map(dir => dir.replace(/^"(.*)"$/, '$1'));
  const extensions = windows && !path.extname(requested) ? ['.exe', '.com', '.cmd', '.bat'] : [''];
  let executable;
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.resolve(directory, requested + extension);
      try { if ((await fs.stat(candidate)).isFile()) { executable = candidate; break; } }
      catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw fail('codex_start_failed', `Cannot inspect Codex executable ${candidate}: ${error.message}`); }
    }
    if (executable) break;
  }
  if (!executable) throw fail('codex_not_found', explicit
    ? `Configured Codex executable was not found: ${requested}`
    : 'Codex is not installed on PATH; install it or supply --codex-bin / CODEX_APP_RUNTIME_CLI_PATH');
  const options = { env: { ...env }, windowsHide: true, shell: false };
  if (!windows || !/\.(cmd|bat)$/i.test(executable)) return { executable, command: executable, args, options };

  const command = envValue(env, 'ComSpec') || (envValue(env, 'SystemRoot') && path.join(envValue(env, 'SystemRoot'), 'System32', 'cmd.exe'));
  if (!command) throw fail('codex_start_failed', `Codex is installed at ${executable}, but ComSpec/SystemRoot is unavailable for its Windows launcher`);
  // Expand each value once through a private environment variable. Quotes protect
  // spaces and shell metacharacters; /v:off prevents ! expansion in paths.
  const references = [executable, ...args].map((value, index) => {
    if (/["\r\n\0]/.test(value)) throw fail('invalid_options', 'Windows batch launcher arguments cannot contain quotes or line breaks');
    const key = `SESSION_MGR_LAUNCH_ARG_${index}`;
    options.env[key] = value;
    return `"%${key}%"`;
  });
  options.windowsVerbatimArguments = true;
  return { executable, command, args: ['/d', '/s', '/v:off', '/c', `"${references.join(' ')}"`], options };
}
