/**
 * Per-host browser manager for the DSH tools.
 *
 * One CDP connection serves every tool call, and the *current tab* is
 * remembered per DSH session in the harness state file. Lanes are passed
 * explicitly (never stored on the shared Browser), so concurrent sessions
 * cannot fight over one mutable pointer; each target keeps one reused Page so
 * network and DOM state survives across calls.
 */

import { join } from "node:path";
import { Browser } from "../src/browser.js";
import { noTab, HarnessError, codes } from "../src/errors.js";
import { listEndpoints } from "../src/cdp/endpoint.js";
import { redactTextForOutput } from "../src/redact.js";
import { TabLockManager, normalizeTask } from "../src/tasks.js";
import { listStates, readState, setTask, updateState } from "../src/state.js";

export class BrowserManager {
  config: any;
  connection: any;
  connecting: any;
  endpointsCache: { at: number; value: any[] | null };
  locks: TabLockManager;
  laneGates: Map<string, Promise<void>>;
  borrowedTabs: Map<string, Set<string>>;
  contexts: Map<string, string>;
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
      strictTabOwnership: config.strictTabOwnership === true,
      allowBorrowUserTabs: config.allowBorrowUserTabs !== false,
      fileLease: config.fileLease === true,
      fileLeaseDir: config.fileLeaseDir,
      fileLeaseHeartbeatMs: Number(config.fileLeaseHeartbeatMs) || 5_000,
      fileLeaseStaleMs: Number(config.fileLeaseStaleMs) || 30_000,
      isolation: config.isolation === "context" ? "context" : "shared",
      ...config,
    };
    this.connection = null;
    this.connecting = null;
    this.endpointsCache = { at: 0, value: null };
    this.locks = new TabLockManager({ timeoutMs: Number(config.taskLockTimeoutMs) || 5_000 });
    this.laneGates = new Map();
    this.borrowedTabs = new Map();
    this.contexts = new Map();
  }

  /** Connect once and reuse; concurrent callers share the same promise. */
  async ensure() {
    if (this.connection && !this.connection.transport.closed) return this.connection;
    if (this.connecting) return this.connecting;
    // A new connection invalidates all in-memory leases from the old session.
    if (!this.connection) {
      await this.locks.clear();
      this.borrowedTabs.clear();
      this.contexts.clear();
    }
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
        const browserStateDir = browser.config && browser.config.stateDir;
        this.locks.configureFileLease({
          fileLease: this.config.fileLease === true && Boolean(browserStateDir || this.config.fileLeaseDir),
          fileDir: this.config.fileLeaseDir || (browserStateDir ? join(browserStateDir, "locks") : null),
          heartbeatMs: this.config.fileLeaseHeartbeatMs,
          staleMs: this.config.fileLeaseStaleMs,
        });
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



  async #ensureTaskContext(task: any, dir: any) {
    if (this.config.isolation !== "context") return null;
    const existing = this.contexts.get(task.id);
    if (existing) return existing;
    const browser = await this.ensure();
    if (task.browserContextId) {
      try {
        const known = await browser.transport.send("Target.getBrowserContexts", {}, { timeoutMs: 5_000 });
        if ((known.browserContextIds || []).includes(task.browserContextId)) {
          this.contexts.set(task.id, task.browserContextId);
          return task.browserContextId;
        }
      } catch {
        /* validation unavailable; create a fresh context below */
      }
      task.browserContextId = null;
      await setTask(task.id, task, dir);
    }
    let result;
    try {
      result = await browser.transport.send("Target.createBrowserContext", {}, { timeoutMs: 10_000 });
    } catch (error: any) {
      throw new HarnessError(codes.E_L2_UNSUPPORTED, "browser does not support Target.createBrowserContext for isolation:context", { cause: error });
    }
    const contextId = result && result.browserContextId;
    if (!contextId) throw new HarnessError(codes.E_L2_UNSUPPORTED, "browser returned no browserContextId for isolation:context");
    this.contexts.set(task.id, contextId);
    task.browserContextId = contextId;
    await setTask(task.id, task, dir);
    return contextId;
  }

  async #disposeTaskContext(taskId: any, explicitId: any = null) {
    const contextId = explicitId || this.contexts.get(String(taskId));
    if (!contextId) return false;
    this.contexts.delete(String(taskId));
    try {
      const browser = await this.ensure();
      await browser.transport.send("Target.disposeBrowserContext", { browserContextId: contextId }, { timeoutMs: 5_000 });
    } catch {
      /* browser/context already gone */
    }
    return true;
  }

  async #disposeAllContexts() {
    const ids = [...this.contexts.keys()];
    for (const taskId of ids) await this.#disposeTaskContext(taskId);
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
      const { task, dir, state } = await this.#taskFor(sessionId);
      this.#assertTaskActive(task);
      const page = await this.pageFor(sessionId);
      await this.#assertTargetOperable(lane, task, page.targetId, dir, state);
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
      const { task, dir } = await this.#taskFor(sessionId);
      this.#assertTaskActive(task);
      const browser = await this.ensure();
      const browserContextId = await this.#ensureTaskContext(task, dir);
      let lease: any = null;
      try {
        const page = await browser.open(String(url), {
          newTab: options.newTab,
          waitUntil: options.waitUntil || "load",
          timeoutMs: options.timeoutMs || 30_000,
          lane,
          browserContextId,
          beforeNavigate: async (targetPage: any) => {
            await this.#ensureNetworkCapture(targetPage);
            const current = await readState(lane, this.#stateDir(await this.ensure()));
            await this.#assertTargetOperable(lane, task, targetPage.targetId, this.#stateDir(await this.ensure()), current);
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

  /** Start a fresh task shell for a lane after its previous task was closed. */
  async startTask(sessionId: any) {
    const lane = this.laneFor(sessionId);
    return this.#withLaneGate(lane, async () => {
      const { task, dir } = await this.#taskFor(sessionId);
      if (task.state !== "closed") throw new HarnessError(codes.E_BAD_ARG || "E_BAD_ARG", "task " + task.id + " is " + task.state + "; start is only valid after close");
      if (task.browserContextId || this.contexts.has(task.id)) {
        await this.#disposeTaskContext(task.id, task.browserContextId).catch(() => {});
      }
      const next = { ...task, state: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), cleanupPolicy: task.cleanupPolicy, browserContextId: null };
      await updateState(lane, (currentState: any) => ({
        ...currentState,
        current: null,
        ownedTabs: [],
        group: null,
        task: next,
      }), dir);
      await this.locks.releaseTask(task.id);
      this.contexts.delete(task.id);
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
      const contextId = task.browserContextId || this.contexts.get(task.id);
      if (contextId) {
        await this.#disposeTaskContext(task.id, contextId);
        closedTabs.push(...ownedTabs);
      } else if (policy === "close-owned") {
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
        task: { ...closing, state: "closed", browserContextId: null },
      }), dir);
      await this.locks.releaseTask(task.id);
      this.borrowedTabs.delete(task.id);
      return { ok: true, task: { ...closing, state: "closed", browserContextId: null }, closedTabs, cleanupPolicy: policy };
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


  #borrowedFor(taskId: any) {
    const key = String(taskId);
    if (!this.borrowedTabs.has(key)) this.borrowedTabs.set(key, new Set());
    return this.borrowedTabs.get(key)!;
  }

  async #targetOwner(targetId: any, dir: any, lane: any) {
    for (const item of await listStates(dir)) {
      if (item.lane === lane) continue;
      if (Array.isArray(item.state.ownedTabs) && item.state.ownedTabs.some((tab: any) => tab.targetId === targetId)) {
        return item.lane;
      }
    }
    return null;
  }

  #borrowedByOther(targetId: any, lane: any) {
    for (const [taskId, targets] of this.borrowedTabs) {
      if (taskId !== String(lane) && targets.has(String(targetId))) return taskId;
    }
    return null;
  }

  async #assertTargetOperable(lane: any, task: any, targetId: any, dir: any, state: any) {
    if (this.config.strictTabOwnership !== true) return;
    const owned = Array.isArray(state.ownedTabs) && state.ownedTabs.some((tab: any) => tab.targetId === targetId);
    if (owned) return;
    if (this.#borrowedFor(task.id).has(String(targetId))) return;
    const owner = await this.#targetOwner(targetId, dir, task.id);
    if (owner) {
      throw new HarnessError(codes.E_TAB_OWNER_CONFLICT, "tab " + targetId + " is owned by task " + owner, {
        details: { targetId, ownerTaskId: owner },
      });
    }
    const borrowedBy = this.#borrowedByOther(targetId, task.id);
    if (borrowedBy) {
      throw new HarnessError(codes.E_TAB_LOCKED, "tab " + targetId + " is borrowed by task " + borrowedBy, {
        details: { targetId, ownerTaskId: borrowedBy },
      });
    }
    throw new HarnessError(codes.E_TAB_BORROW_REQUIRED, "tab " + targetId + " is not owned by this task; use browser_tabs use {borrow:true} after confirming with the user", {
      details: { targetId },
    });
  }

  /** Attach the session to an existing tab by id or URL substring. */
  async useTab(sessionId: any, targetId: any, { borrow = false }: any = {} as any) {
    const lane = this.laneFor(sessionId);
    return this.#withLaneGate(lane, async () => {
      const { task, state, dir } = await this.#taskFor(sessionId);
      this.#assertTaskActive(task);
      const browser = await this.ensure();
      const contextIsolation = this.config.isolation === "context";
      if ((this.config.strictTabOwnership === true || contextIsolation) && browser.transport && typeof browser.transport.send === "function") {
        const targets = await browser.transport.send("Target.getTargets", {}, { timeoutMs: 5_000 });
        const exact = (targets.targetInfos || []).find((target: any) => target.targetId === String(targetId) && target.type === "page");
        if (exact) {
          const owned = Array.isArray(state.ownedTabs) && state.ownedTabs.some((tab: any) => tab.targetId === exact.targetId);
          if (contextIsolation && !owned) {
            throw new HarnessError(codes.E_POLICY_DENIED, "context isolation cannot borrow tabs outside this task's browser context", { details: { targetId: exact.targetId } });
          }
          if (this.config.strictTabOwnership === true && !owned) {
            const owner = await this.#targetOwner(exact.targetId, dir, task.id);
            if (owner) throw new HarnessError(codes.E_TAB_OWNER_CONFLICT, "tab " + exact.targetId + " is owned by task " + owner, { details: { targetId: exact.targetId, ownerTaskId: owner } });
            const borrowedBy = this.#borrowedByOther(exact.targetId, task.id);
            if (borrowedBy) throw new HarnessError(codes.E_TAB_LOCKED, "tab " + exact.targetId + " is borrowed by task " + borrowedBy, { details: { targetId: exact.targetId, ownerTaskId: borrowedBy } });
            if (!borrow) throw new HarnessError(codes.E_TAB_BORROW_REQUIRED, "tab " + exact.targetId + " is not owned by this task; use browser_tabs use {borrow:true} after confirming with the user", { details: { targetId: exact.targetId } });
            if (this.config.allowBorrowUserTabs === false) throw new HarnessError(codes.E_POLICY_DENIED, "borrowing user tabs is disabled by configuration", { details: { targetId: exact.targetId } });
            this.#borrowedFor(task.id).add(exact.targetId);
          }
        }
      }
      const page = await browser.use(targetId, { lane });
      const previous = state.current && state.current.targetId;
      if (previous && previous !== page.targetId) this.#borrowedFor(task.id).delete(previous);
      return page;
    });
  }

  /** Create a background tab for the session. */
  async openTab(sessionId: any, url: any = "about:blank") {
    const lane = this.laneFor(sessionId);
    return this.#withLaneGate(lane, async () => {
      const { task, dir } = await this.#taskFor(sessionId);
      this.#assertTaskActive(task);
      const browser = await this.ensure();
      const browserContextId = await this.#ensureTaskContext(task, dir);
      const page = await browser.newTab(url || "about:blank", { lane, browserContextId });
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

  /**
   * Close every non-closed task found in this stateDir, respecting each task's
   * cleanupPolicy. Used on plugin teardown; normal CLI close() must not clean
   * tasks because the next CLI process reuses their current tab.
   */
  async cleanupSessions() {
    const browser = this.connection;
    const dir = this.config.stateDir || (browser && browser.config && browser.config.stateDir);
    if (!browser || !dir) return { cleaned: 0, closedTabs: 0 };
    const states = await listStates(dir);
    let cleaned = 0;
    let closedTabs = 0;
    for (const entry of states as any[]) {
      const task = entry.state && entry.state.task;
      if (!task || task.state === "closed") continue;
      const lane = task.id || entry.lane;
      const ownedTabs = Array.isArray(entry.state.ownedTabs) ? entry.state.ownedTabs.map((tab: any) => tab.targetId).filter(Boolean) : [];
      const contextId = task.browserContextId || this.contexts.get(lane);
      if (contextId) {
        await this.#disposeTaskContext(lane, contextId).catch(() => {});
        closedTabs += ownedTabs.length;
      } else if (task.cleanupPolicy !== "leave") {
        for (const targetId of ownedTabs) {
          let lease: any = null;
          try {
            lease = await this.locks.acquire(targetId, lane, { timeoutMs: 500 });
            await browser.closeTab(targetId, { lane });
            closedTabs += 1;
          } catch {
            /* already gone or held elsewhere */
          } finally {
            if (lease) await lease.release().catch(() => {});
          }
        }
      }
      await this.locks.releaseTask(lane).catch(() => {});
      this.borrowedTabs.delete(lane);
      const closedTask = { ...task, state: "closed", updatedAt: new Date().toISOString(), browserContextId: null };
      await updateState(lane, (currentState: any) => ({
        ...currentState,
        current: null,
        ownedTabs: [],
        group: null,
        task: closedTask,
      }), dir).catch(() => {});
      cleaned += 1;
    }
    return { cleaned, closedTabs };
  }

  /** Plugin teardown: clean owned tasks first, then close the CDP connection. */
  async dispose() {
    const result = await this.cleanupSessions().catch(() => ({ cleaned: 0, closedTabs: 0 }));
    await this.close();
    return result;
  }

  async close() {
    const connection = this.connection;
    await this.#disposeAllContexts().catch(() => {});
    this.connection = null;
    this.endpointsCache = { at: 0, value: null };
    await this.locks.clear();
    this.laneGates.clear();
    this.contexts.clear();
    if (connection) {
      try { await connection.close(); } catch { /* ignore */ }
    }
  }
}