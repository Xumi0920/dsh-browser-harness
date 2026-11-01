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
import { noTab, HarnessError } from "../src/errors.js";
import { listEndpoints } from "../src/cdp/endpoint.js";
import { redactTextForOutput } from "../src/redact.js";

export class BrowserManager {
  config: any;
  connection: any;
  connecting: any;
  endpointsCache: { at: number; value: any[] | null };
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
  }

  /** Connect once and reuse; concurrent callers share the same promise. */
  async ensure() {
    if (this.connection && !this.connection.transport.closed) return this.connection;
    if (this.connecting) return this.connecting;
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
    const browser = await this.ensure();
    return browser.use(targetId, { lane: this.laneFor(sessionId) });
  }

  /** Create a background tab for the session. */
  async openTab(sessionId: any, url: any = "about:blank") {
    const browser = await this.ensure();
    const page = await browser.newTab(url || "about:blank", { lane: this.laneFor(sessionId) });
    return this.#ensureNetworkCapture(page);
  }

  /** Close a tab this harness created (policy is enforced by Browser). */
  async closeTab(sessionId: any, targetId: any) {
    const browser = await this.ensure();
    return browser.closeTab(targetId, { lane: this.laneFor(sessionId) });
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
    if (connection) {
      try { await connection.close(); } catch { /* ignore */ }
    }
  }
}