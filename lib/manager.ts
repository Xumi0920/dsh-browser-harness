/**
 * Per-host browser manager for the DSH tools.
 *
 * One CDP connection serves every tool call, and the *current tab* is
 * remembered per DSH session in the harness state file. Lanes are passed
 * explicitly (never stored on the shared Browser), so concurrent sessions
 * cannot fight over one mutable pointer; each target keeps one reused Page so
 * network and DOM state survives across calls.
 */

import { Browser } from "../src/browser.js";
import { noTab, HarnessError, codes } from "../src/errors.js";
import { listEndpoints } from "../src/cdp/endpoint.js";
import { redactTextForOutput } from "../src/redact.js";
import { TabLockManager, normalizeTask } from "../src/tasks.js";
import { readState, setTask, updateState } from "../src/state.js";

export class BrowserManager {
  config: any;
  connection: any;
  connecting: any;
  endpointsCache: { at: number; value: any[] | null };
  locks: TabLockManager;
  laneGates: Map<string, Promise<void>>;
  constructor(config: any = {} as any) {
    this.config = {
      browser: undefined,
      cdpUrl: undefined,
      ws: undefined,
      stateDir: undefined,
      downloadDir: undefined,
      dialogPolicy: "auto-dismiss",
      endpointCacheMs: 1_500,
      browserFactory: undefined,
      ...config,
    };
    this.connection = null;
    this.connecting = null;
    this.endpointsCache = { at: 0, value: null };
    this.locks = new TabLockManager({ timeoutMs: Number(config.taskLockTimeoutMs) || 5_000 });
    this.laneGates = new Map();
  }

  /** Connect once and reuse; concurrent callers share the same promise. */
  async ensure() {
    if (this.connection && !this.connection.transport.closed) return this.connection;
    if (this.connecting) return this.connecting;
    // A new connection invalidates all in-memory leases from the old session.
    if (!this.connection) this.locks.clear();
    this.connecting = (async () => {
      try {
        const connect = typeof this.config.browserFactory === "function" ? this.config.browserFactory : Browser.connect;
        const browser = await connect({
          browser: this.config.browser,
          cdpUrl: this.config.cdpUrl,
          ws: this.config.ws,
          stateDir: this.config.stateDir,
          downloadDir: this.config.downloadDir,
          screenshotDir: this.config.screenshotDir,
          uploadDir: this.config.uploadDir,
          dialogPolicy: this.config.dialogPolicy,
          tabGroups: this.config.tabGroups,
          tabGroupTitle: this.config.tabGroupTitle,
          tabGroupColor: this.config.tabGroupColor,
          extensionPath: this.config.extensionPath,
          extensionId: this.config.extensionId,
          lane: "dsh",
        });
        this.connection = browser;
        return browser;
      } catch (error: any) {
        // Keep the stable code and a safe hint; never copy the raw connect error
        // (it may contain a tokenized CDP URL or other configured credentials).
        throw new HarnessError(
          (error && error.code) || "E_NO_BROWSER",
          "cannot reach a dedicated automation browser — start a Chromium-based browser with --remote-debugging-port (e.g. the 9331 Chrome or 9332 Edge instance in ~/.dsh/browser-cdp) or configure browser/cdpUrl. Connection error details are intentionally omitted.",
          { code: (error && error.code) || "E_NO_BROWSER" },
        );
      } finally {
        this.connecting = null;
      }
    })();
    return this.connecting;
  }

  /** State-file lane for one DSH session (sanitized, stable, bounded). */
  laneFor(sessionId: any) {
    const id = sessionId ? String(sessionId).replace(/[^a-zA-Z0-9_-]+/g, "-") : "default";
    return "dsh-" + id.slice(-40);
  }

  /** The shared connection (kept for callers that already know the lane). */
  async browserFor() {
    return this.ensure();
  }

  /** Best-effort network capture so browser_extract network sees this tab's requests. */
  async #ensureNetworkCapture(page: any) {
    if (page.networkEnabled) return page;
    try {
      await page.startNetworkCapture();
    } catch {
      /* capture is optional; the tool reports capturing:false */
    }
    return page;
  }


  #stateDir(browser: any) {
    return browser && browser.config ? browser.config.stateDir : this.config.stateDir;
  }

  /** Load (or create) the durable task record for this session/lane. */
  async #taskFor(sessionId: any) {
    const browser = await this.ensure();
    const lane = this.laneFor(sessionId);
    const dir = this.#stateDir(browser);
    const state = await readState(lane, dir);
    const task = normalizeTask(state.task, lane);
    if (!state.task) await setTask(lane, task, dir);
    return { browser, lane, dir, task, state };
  }

  #assertTaskActive(task: any) {
    if (task.state === "paused") throw new HarnessError(codes.E_TASK_PAUSED, "task " + task.id + " is paused; resume it before operating on pages");
    if (task.state === "closing") throw new HarnessError(codes.E_TASK_CLOSING, "task " + task.id + " is closing; no new page operations are allowed");
    if (task.state === "closed") throw new HarnessError(codes.E_TASK_CLOSED, "task " + task.id + " is closed; start a new session task");
  }

  /** Serialize current-pointer changes and lifecycle transitions for one lane. */
  async #withLaneGate(lane: any, fn: any) {
    const previous = this.laneGates.get(lane) || Promise.resolve();
    let release: any;
    const gate = new Promise((resolve) => { release = resolve; });
    const chain: Promise<void> = previous.then(async () => { await gate; });
    this.laneGates.set(lane, chain);
    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.laneGates.get(lane) === chain) this.laneGates.delete(lane);
    }
  }

  /**
   * Run one page operation under the task gate and an exclusive tab lease.
   * The lease is always released after the callback, including on errors.
   */
  async withPage(sessionId: any, fn: any, { timeoutMs = this.locks.timeoutMs }: any = {} as any) {
    const lane = this.laneFor(sessionId);
    return this.#withLaneGate(lane, async () => {
      const { task } = await this.#taskFor(sessionId);
      this.#assertTaskActive(task);
      const page = await this.pageFor(sessionId);
      const lease = await this.locks.acquire(page.targetId, task.id, { timeoutMs });
      try {
        return await fn(page, lease);
      } finally {
        await lease.release();
      }
    });
  }

  /** Navigate/open while holding the destination tab lease for the whole callback. */
  async withNavigatedPage(sessionId: any, url: any, options: any = {} as any, fn: any) {
    const lane = this.laneFor(sessionId);
    return this.#withLaneGate(lane, async () => {
      const { task } = await this.#taskFor(sessionId);
      this.#assertTaskActive(task);
      const browser = await this.ensure();
      let lease: any = null;
      try {
        const page = await browser.open(String(url), {
          newTab: options.newTab,
          waitUntil: options.waitUntil || "load",
          timeoutMs: options.timeoutMs || 30_000,
          lane,
          beforeNavigate: async (targetPage: any) => {
            await this.#ensureNetworkCapture(targetPage);
            lease = await this.locks.acquire(targetPage.targetId, task.id, { timeoutMs: options.timeoutMs || this.locks.timeoutMs });
          },
        });
        if (!lease) lease = await this.locks.acquire(page.targetId, task.id, { timeoutMs: options.timeoutMs || this.locks.timeoutMs });
        await this.#ensureNetworkCapture(page);
        return await fn(page, lease);
      } finally {
        if (lease) await lease.release();
      }
    });
  }

  async taskStatus(sessionId: any) {
    const { lane, task, state } = await this.#taskFor(sessionId);
    const currentTargetId = state.current && state.current.targetId;
    return {
      lane,
      task,
      current: state.current,
      ownedTabs: state.ownedTabs,
      group: state.group || null,
      locks: this.locks.taskLocks(task.id),
      currentLock: currentTargetId ? this.locks.heldBy(currentTargetId) : null,
    };
  }

  async pauseTask(sessionId: any) {
    const lane = this.laneFor(sessionId);
    return this.#withLaneGate(lane, async () => {
      const { task, dir } = await this.#taskFor(sessionId);
      if (task.state === "closed") throw new HarnessError(codes.E_TASK_CLOSED, "task " + task.id + " is already closed");
      if (task.state === "paused") return { ok: true, task };
      await this.locks.releaseTask(task.id);
      const next = { ...task, state: "paused" };
      await setTask(lane, next, dir);
      return { ok: true, task: next };
    });
  }

  async resumeTask(sessionId: any) {
    const lane = this.laneFor(sessionId);
    return this.#withLaneGate(lane, async () => {
      const { task, dir } = await this.#taskFor(sessionId);
      if (task.state === "closed") throw new HarnessError(codes.E_TASK_CLOSED, "task " + task.id + " is already closed");
      if (task.state === "active") return { ok: true, task };
      const next = { ...task, state: "active" };
      await setTask(lane, next, dir);
      return { ok: true, task: next };
    });
  }

  /** Close a task, optionally closing its owned tabs, and release all leases. */
  async closeTask(sessionId: any, { cleanup }: any = {} as any) {
    const lane = this.laneFor(sessionId);
    return this.#withLaneGate(lane, async () => {
      const { browser, task, dir, state } = await this.#taskFor(sessionId);
      if (task.state === "closed") return { ok: true, task, closedTabs: [] };
      const closing = { ...task, state: "closing" };
      await setTask(lane, closing, dir);
      const policy = cleanup === "leave" || cleanup === "close-owned" ? cleanup : task.cleanupPolicy;
      const ownedTabs = Array.isArray(state.ownedTabs) ? state.ownedTabs.map((tab: any) => tab.targetId).filter(Boolean) : [];
      const closedTabs = [];
      if (policy === "close-owned") {
        for (const targetId of ownedTabs) {
          let lease: any = null;
          try {
            lease = await this.locks.acquire(targetId, task.id, { timeoutMs: 1000 });
            await browser.closeTab(targetId, { lane });
            closedTabs.push(targetId);
          } catch {
            /* already gone or held by another task; cleanup is best effort */
          } finally {
            if (lease) await lease.release();
          }
        }
      }
      await updateState(lane, (currentState: any) => ({
        ...currentState,
        current: null,
        ownedTabs: [],
        group: null,
        task: { ...closing, state: "closed" },
      }), dir);
      await this.locks.releaseTask(task.id);
      return { ok: true, task: { ...closing, state: "closed" }, closedTabs, cleanupPolicy: policy };
    });
  }

  /** Attach to the session's current tab, or fail with an actionable hint. */
  async pageFor(sessionId: any) {
    const lane = this.laneFor(sessionId);
    const browser = await this.ensure();
    const current = await browser.current(lane);
    if (!current) throw noTab("no browser tab is open for this session; call browser_navigate first");
    return this.#ensureNetworkCapture(await browser.attach(current.targetId));
  }

  async navigate(sessionId: any, url: any, options: any = {} as any) {
    const browser = await this.ensure();
    const page = await browser.open(String(url), {
      newTab: options.newTab,
      waitUntil: options.waitUntil || "load",
      timeoutMs: options.timeoutMs || 30_000,
      lane: this.laneFor(sessionId),
      beforeNavigate: (targetPage: any) => this.#ensureNetworkCapture(targetPage),
    });
    return this.#ensureNetworkCapture(page);
  }

  /**
   * Endpoint discovery probes every known browser port. browser_status is a
   * diagnostic call that users run repeatedly, so cache the probe result for a
   * short TTL (configurable; 0 disables the cache).
   */
  async #endpoints() {
    const ttl = Number(this.config.endpointCacheMs);
    const now = Date.now();
    if (ttl > 0 && this.endpointsCache.value && now - this.endpointsCache.at < ttl) {
      return this.endpointsCache.value;
    }
    const value = await listEndpoints({});
    this.endpointsCache = { at: now, value };
    return value;
  }

  /** Tabs plus the session's current tab pointer. */
  async listTabs(sessionId: any) {
    const browser = await this.ensure();
    const lane = this.laneFor(sessionId);
    return { tabs: await browser.listTabs({ lane }), current: await browser.current(lane) };
  }

  /** Attach the session to an existing tab by id or URL substring. */
  async useTab(sessionId: any, targetId: any) {
    const lane = this.laneFor(sessionId);
    return this.#withLaneGate(lane, async () => {
      const { task } = await this.#taskFor(sessionId);
      this.#assertTaskActive(task);
      const browser = await this.ensure();
      return browser.use(targetId, { lane });
    });
  }

  /** Create a background tab for the session. */
  async openTab(sessionId: any, url: any = "about:blank") {
    const lane = this.laneFor(sessionId);
    return this.#withLaneGate(lane, async () => {
      const { task } = await this.#taskFor(sessionId);
      this.#assertTaskActive(task);
      const browser = await this.ensure();
      const page = await browser.newTab(url || "about:blank", { lane });
      return this.#ensureNetworkCapture(page);
    });
  }

  /** Close a tab this harness created (policy is enforced by Browser). */
  async closeTab(sessionId: any, targetId: any) {
    const lane = this.laneFor(sessionId);
    return this.#withLaneGate(lane, async () => {
      const { task, state } = await this.#taskFor(sessionId);
      this.#assertTaskActive(task);
      const id = targetId || (state.current && state.current.targetId);
      if (!id) throw noTab("close needs a targetId or current tab");
      const lease = await this.locks.acquire(id, task.id, { timeoutMs: this.locks.timeoutMs });
      try {
        const browser = await this.ensure();
        return await browser.closeTab(id, { lane });
      } finally {
        await lease.release();
      }
    });
  }

  async status(sessionId: any) {
    const endpoints = await this.#endpoints();
    let current = null;
    let tabs = [];
    let version = null;
    let tabGroups = null;
    try {
      const browser = await this.ensure();
      version = browser.version;
      const lane = this.laneFor(sessionId);
      tabs = await browser.listTabs({ lane });
      current = await browser.current(lane);
      tabGroups = browser.tabGroups ? browser.tabGroups.info() : null;
    } catch (error: any) {
      return { connected: false, error: redactTextForOutput(error && error.message), endpoints, tabs: [], current: null, version: null };
    }
    return { connected: true, version, tabs, current, tabGroups, endpoints };
  }

  async close() {
    const connection = this.connection;
    this.connection = null;
    this.endpointsCache = { at: 0, value: null };
    this.locks.clear();
    this.laneGates.clear();
    if (connection) {
      try { await connection.close(); } catch { /* ignore */ }
    }
  }
}