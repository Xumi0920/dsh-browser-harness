/**
 * Per-host browser manager for the DSH tools.
 *
 * One CDP connection serves every tool call; the *current tab* is remembered
 * per DSH session in the harness state file, so two sessions do not fight over
 * the same tab pointer.
 */

import { Browser } from "../src/browser.mjs";
import { noTab, HarnessError } from "../src/errors.mjs";
import { listEndpoints } from "../src/cdp/endpoint.mjs";

export class BrowserManager {
  constructor(config = {}) {
    this.config = {
      browser: undefined,
      cdpUrl: undefined,
      ws: undefined,
      stateDir: undefined,
      downloadDir: undefined,
      dialogPolicy: "auto-dismiss",
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
        const browser = await Browser.connect({
          browser: this.config.browser,
          cdpUrl: this.config.cdpUrl,
          ws: this.config.ws,
          stateDir: this.config.stateDir,
          downloadDir: this.config.downloadDir,
          dialogPolicy: this.config.dialogPolicy,
          lane: "dsh",
        });
        this.connection = browser;
        return browser;
      } catch (error) {
        throw new HarnessError(
          error.code || "E_NO_BROWSER",
          "cannot reach a dedicated automation browser: " + error.message +
            " — start Chrome with --remote-debugging-port (e.g. the 9331 instance in ~/.dsh/browser-cdp) or configure browser/cdpUrl.",
          { cause: error },
        );
      } finally {
        this.connecting = null;
      }
    })();
    return this.connecting;
  }

  laneFor(sessionId) {
    const id = sessionId ? String(sessionId).replace(/[^a-zA-Z0-9_-]+/g, "-") : "default";
    return "dsh-" + id.slice(-40);
  }

  async browserFor(sessionId) {
    const browser = await this.ensure();
    browser.lane = this.laneFor(sessionId);
    return browser;
  }

  /** Attach to the session's current tab, or fail with an actionable hint. */
  async pageFor(sessionId) {
    const browser = await this.browserFor(sessionId);
    const current = await browser.current();
    if (!current) throw noTab("no browser tab is open for this session; call browser_navigate first");
    return browser.attach(current.targetId);
  }

  async navigate(sessionId, url, options = {}) {
    const browser = await this.browserFor(sessionId);
    return browser.open(url, { newTab: options.newTab, waitUntil: options.waitUntil || "load", timeoutMs: options.timeoutMs || 30_000 });
  }

  async status() {
    const endpoints = await listEndpoints({});
    let current = null;
    let tabs = [];
    let version = null;
    try {
      const browser = await this.ensure();
      version = browser.version;
      tabs = await browser.listTabs();
      const state = await browser.current();
      current = state;
    } catch (error) {
      return { connected: false, error: error.message, endpoints, tabs: [], current: null, version: null };
    }
    return { connected: true, version, tabs, current, endpoints };
  }

  async close() {
    try { this.connection?.close(); } catch { /* ignore */ }
    this.connection = null;
  }
}
