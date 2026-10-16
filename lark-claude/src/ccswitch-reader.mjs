import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

const ACTIONS = new Set(["overview", "providers", "health", "routing_status", "usage"]);
const PERIODS = new Set(["today", "yesterday", "last_7_days", "last_30_days"]);
const ERROR_CODES = new Set([
  "not_installed", "schema_incompatible", "data_invalid", "read_busy",
  "read_failed", "read_timeout", "read_unavailable", "resource_limit",
]);

export class CcSwitchReadError extends Error {
  constructor(code) {
    super(code);
    this.name = "CcSwitchReadError";
    this.code = ERROR_CODES.has(code) ? code : "read_failed";
  }
}

export class CcSwitchReader {
  constructor({
    root = path.join(os.homedir(), ".cc-switch"),
    timeoutMs = 3000,
    WorkerImpl = Worker,
  } = {}) {
    this.root = root;
    this.timeoutMs = timeoutMs;
    this.WorkerImpl = WorkerImpl;
  }

  read(action, period = null, nowMs = Date.now()) {
    if (!ACTIONS.has(action)) return Promise.reject(new CcSwitchReadError("data_invalid"));
    if (action === "usage") period ||= "today";
    if ((action === "usage" && !PERIODS.has(period)) || (action !== "usage" && period !== null)) {
      return Promise.reject(new CcSwitchReadError("data_invalid"));
    }
    if (!Number.isSafeInteger(nowMs) || nowMs <= 0) return Promise.reject(new CcSwitchReadError("data_invalid"));

    return new Promise((resolve, reject) => {
      const worker = new this.WorkerImpl(new URL("./ccswitch-worker.mjs", import.meta.url), {
        workerData: Object.freeze({ root: this.root, action, period, nowMs }),
        execArgv: [],
      });
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => {
        worker.terminate();
        finish(new CcSwitchReadError("read_timeout"));
      }, this.timeoutMs);
      timer.unref?.();
      worker.once("message", (message) => {
        if (!message || message.ok !== true || !message.result || typeof message.result !== "object") {
          return finish(new CcSwitchReadError(message?.code));
        }
        finish(null, message.result);
      });
      worker.once("error", () => finish(new CcSwitchReadError("read_failed")));
      worker.once("exit", (code) => {
        if (!settled) finish(new CcSwitchReadError("read_failed"));
      });
    });
  }
}

