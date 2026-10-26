import fs from "node:fs";

function validRequest(value) {
  return value && typeof value === "object"
    && typeof value.requestedAt === "string" && Number.isFinite(Date.parse(value.requestedAt))
    && typeof value.nonce === "string" && /^[0-9a-f]{16,64}$/i.test(value.nonce);
}

export class RestartCoordinator {
  constructor({ markerPath, listener, scheduler, store, handleMessage, persistFencedMessage,
    replayPending, updateHealth, onRestartReady, fsImpl = fs }) {
    this.markerPath = markerPath;
    this.listener = listener;
    this.scheduler = scheduler;
    this.store = store;
    this.handleMessage = handleMessage;
    this.persistFencedMessage = persistFencedMessage;
    this.replayPending = replayPending;
    this.updateHealth = updateHealth;
    this.onRestartReady = onRestartReady;
    this.fs = fsImpl;
    this.fenced = false;
    this.checking = false;
    this.inFlight = 0;
    this.waiters = [];
  }

  async dispatch(message) {
    if (this.fenced) {
      await this.persistFencedMessage(message);
      return "fenced";
    }
    this.inFlight += 1;
    try {
      await this.handleMessage(message);
      return "handled";
    } finally {
      this.inFlight -= 1;
      if (this.inFlight === 0) {
        for (const resolve of this.waiters.splice(0)) resolve();
      }
    }
  }

  async check() {
    if (this.checking || !this.fs.existsSync(this.markerPath)) return "none";
    this.checking = true;
    let request;
    try {
      request = JSON.parse(this.fs.readFileSync(this.markerPath, "utf8"));
      if (!validRequest(request)) throw new Error("restart request marker is invalid");
    } catch (error) {
      this.#removeMarker();
      this.updateHealth({ restartError: error.message, restartReady: false, restartDeferred: false });
      this.checking = false;
      return "invalid";
    }

    this.fenced = true;
    this.updateHealth({ restartRequestedAt: request.requestedAt, restartReady: false, restartDeferred: false });
    let listenerStopped = false;
    try {
      await this.listener.stop();
      listenerStopped = true;
      await this.#waitForHandlers();
      this.scheduler.reconcileQueuedTasks?.({ drain: false });
      const busy = this.scheduler.activitySnapshot(1).length > 0
        || (this.store.listQueuedTasks?.().length || 0) > 0;
      if (busy) {
        this.#removeMarker();
        await this.listener.start();
        listenerStopped = false;
        await this.replayPending();
        this.scheduler.reconcileQueuedTasks?.();
        this.fenced = false;
        this.updateHealth({ restartDeferred: true, restartReady: false, restartError: null });
        return "deferred";
      }
      this.updateHealth({ restartReady: true, restartDeferred: false, restartError: null });
      await this.onRestartReady();
      return "ready";
    } catch (error) {
      this.#removeMarker();
      if (listenerStopped) await this.listener.start().catch(() => {});
      this.fenced = false;
      this.updateHealth({ restartError: error.message, restartReady: false, restartDeferred: false });
      throw error;
    } finally {
      this.checking = false;
    }
  }

  #waitForHandlers() {
    if (this.inFlight === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  #removeMarker() {
    try { this.fs.unlinkSync(this.markerPath); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}
