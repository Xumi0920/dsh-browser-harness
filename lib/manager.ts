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

export class BrowserManager {
  config: any;
  connection: any;
  connecting: any;
  constructor(config: any = {} as any) {
    this.config = {
      browser: undefined,
      cdpUrl: undefined,
      ws: undefined,
      stateDir: undefined,
      downloadDir: undefined,
      dialogPolicy: "auto-dismiss",
      browserFactory: undefined,
      ...config,
    };
    this.connection = null;
    this.connecting = null;
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
        throw new HarnessError(
          error.code || "E_NO_BROWSER",
          "cannot reach a dedicated automation browser: " + error.message +
            " — start a Chromium-based browser with --remote-debugging-port (e.g. the 9331 Chrome or 9332 Edge instance in ~/.dsh/browser-cdp) or configure browser/cdpUrl.",
          { cause: error },
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
    const endpoints = await listEndpoints({});
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
      return { connected: false, error: error.message, endpoints, tabs: [], current: null, version: null };
    }
    return { connected: true, version, tabs, current, tabGroups, endpoints };
  }

  async close() {
    const connection = this.connection;
    this.connection = null;
    if (connection) {
      try { await connection.close(); } catch { /* ignore */ }
    }
  }
}