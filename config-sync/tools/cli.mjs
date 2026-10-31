import { context, execute } from './engine.mjs';
import { watch } from './watch.mjs';
import { SyncError, fail } from './documents.mjs';

try {
  const [mode, ...args] = process.argv.slice(2), options = {}, paths = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--what-if') options.whatIf = true;
    else if (arg === '--rebaseline') options.rebaseline = true;
    else if (arg === '--once') options.once = true;
    else if (['--agents-root', '--user-home', '--codex-root', '--temp-root', '--local-app-data'].includes(arg)) {
      if (!args[i + 1]) fail('missing-argument');
      paths[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = args[++i];
    } else if (arg === '--resolve-conflict') options.resolveConflict = args[++i];
    else if (arg === '--transaction-id') options.transactionId = args[++i];
    else fail('unknown-argument');
  }
  const ctx = context(paths);
  if (mode === 'watch') {
    if (options.whatIf) console.log(JSON.stringify(execute(ctx, 'check')));
    else await watch(ctx, options);
  } else console.log(JSON.stringify(execute(ctx, mode, options), null, 2));
} catch (error) {
  const result = error instanceof SyncError ? { status: error.code, ...error.detail } : { status: 'io-or-runtime-error' };
  console.error(JSON.stringify(result));
  process.exitCode = result.status === 'conflict' ? 2 : 1;
}
