import { spawn } from "node:child_process";

export function runProcess(file, args, options = {}) {
  const {
    cwd,
    env,
    input,
    timeoutMs = 0,
    signal,
    windowsHide = true,
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      env,
      windowsHide,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(result);
    };

    const terminate = () => {
      if (child.exitCode !== null) return;
      child.kill();
      if (process.platform === "win32") {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.unref();
      }
    };

    const onAbort = () => {
      terminate();
      const error = new Error("Process aborted");
      error.name = "AbortError";
      finish(error);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish(error));
    child.on("close", (code, processSignal) => finish(null, { code, signal: processSignal, stdout, stderr, pid: child.pid }));

    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        terminate();
        const error = new Error(`Process timed out after ${timeoutMs}ms`);
        error.code = "ETIMEDOUT";
        finish(error);
      }, timeoutMs);
      timer.unref?.();
    }

    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
