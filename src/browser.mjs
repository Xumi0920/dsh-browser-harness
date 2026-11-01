/**
 * Browser-level orchestration: endpoint discovery, targets, tab ownership, and
 * the daemon-less current-tab model (state file + fresh attach per call).
 */

import { join } from "node:path";
import { CDPTransport, connectTransport } from "./cdp/transport.mjs";
import { resolveEndpoint } from "./cdp/endpoint.mjs";
import { Page } from "./page.mjs";
import * as stateStore from "./state.mjs";
import { badArgument, elementNotFound, noTab, policyDenied, staleTarget, targetGone } from "./errors.mjs";

const INTERNAL_URL = /^(chrome|devtools|edge|about:blank|chrome-extension):/;
const DEFAULT_TIMEOUT_MS = 15_000;

function isRealPage(target) {
  return target && target.type === "page" && !INTERNAL_URL.test(String(target.url || "")) && !String(target.url || "").includes("omnibox-popup");
}

/** One connection to one running Chrome instance. */
export class Browser {
  /**
   * @param {{
   *   transport: CDPTransport,
   *   endpoint: { wsUrl: string, httpUrl?: string, browser?: string, source: string },
   *   lane?: string,
   *   config?: { stateDir?: string, downloadDir?: string, dialogPolicy?: string, marker?: string },
   * }} options
   */
  constructor(options) {
    this.transport = options.transport;
    this.endpoint = options.endpoint;
    this.lane = options.lane || "default";
    this.config = { marker: stateStore.DEFAULT_MARKER, dialogPolicy: "auto-dismiss", focusEmulation: true, ...(options.config || {}) };
    this.config.stateDir = this.config.stateDir || stateStore.defaultStateDir();
    this.config.downloadDir = this.config.downloadDir || join(this.config.stateDir, "downloads");
    this.version = null;
  }

  /**
   * Connect to a running browser.
   * @param {{
   *   ws?: string, cdpUrl?: string, browser?: string, lane?: string,
   *   stateDir?: string, downloadDir?: string, dialogPolicy?: string,
   *   fetchImpl?: typeof fetch, WebSocketImpl?: any, timeoutMs?: number,
   * }} [options]
   */
  static async connect(options = {}) {
    const endpoint = await resolveEndpoint(options);
    const transport = new CDPTransport(endpoint.wsUrl, {
      WebSocketImpl: options.WebSocketImpl,
      defaultTimeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    await transport.connect();
    const browser = new Browser({
      transport,
      endpoint,
      lane: options.lane,
      config: {
        stateDir: options.stateDir,
        downloadDir: options.downloadDir,
        dialogPolicy: options.dialogPolicy,
        focusEmulation: options.focusEmulation,
        marker: options.marker,
      },
    });
    browser.version = await browser.transport.send("Browser.getVersion", {}, { timeoutMs: 5_000 }).catch(() => null);
    return browser;
  }

  /** All real page targets. */
  async listTabs({ includeChrome = false } = {}) {
    const result = await this.transport.send("Target.getTargets", {}, { timeoutMs: 5_000 });
    const targets = (result.targetInfos || []).filter((target) => target.type === "page");
    const filtered = includeChrome ? targets : targets.filter((target) => isRealPage(target) || target.url === "about:blank");
    return filtered.map((target) => ({ targetId: target.targetId, url: target.url, title: target.title, owned: false }));
  }

  async #currentState() {
    return stateStore.readState(this.lane, this.config.stateDir);
  }

  /** The remembered current tab, validated against live targets. */
  async current() {
    const state = await this.#currentState();
    if (!state.current) return null;
    const targets = await this.transport.send("Target.getTargets", {}, { timeoutMs: 5_000 }).catch(() => ({ targetInfos: [] }));
    const live = (targets.targetInfos || []).find((target) => target.targetId === state.current.targetId);
    if (!live) return null;
    return { targetId: live.targetId, url: live.url, title: live.title };
  }

  /** Attach to a target and return a Page. */
  async attach(targetId) {
    let result;
    try {
      result = await this.transport.send("Target.attachToTarget", { targetId, flatten: true }, { timeoutMs: 5_000 });
    } catch (error) {
      if (/No target|target.*(closed|not found)|Session with given id not found/i.test(String(error.message))) throw targetGone(targetId);
      throw error;
    }
    const page = new Page(this, { sessionId: result.sessionId, targetId });
    await page.enableDomains();
    return page;
  }

  /** Reuse the remembered tab when it matches, otherwise open a new one. */
  async open(url, { newTab = false, waitUntil = "load", timeoutMs = 30_000 } = {}) {
    if (typeof url !== "string" || url.length === 0) throw badArgument("open(url) needs a URL");
    if (!newTab) {
      const existing = await this.current();
      if (existing) {
        const page = await this.attach(existing.targetId);
        await page.navigate(url, { waitUntil, timeoutMs });
        await this.#rememberCurrent(page);
        return page;
      }
    }
    return this.newTab(url, { waitUntil, timeoutMs });
  }

  /** Create a background tab (never foregrounded) and optionally navigate it. */
  async newTab(url = "about:blank", { waitUntil = "load", timeoutMs = 30_000 } = {}) {
    const created = await this.transport.send("Target.createTarget", { url: "about:blank", background: true }, { timeoutMs: 10_000 });
    const page = await this.attach(created.targetId);
    await stateStore.rememberOwnedTab(this.lane, { targetId: created.targetId, url: "about:blank" }, this.config.stateDir);
    if (url && url !== "about:blank") await page.navigate(url, { waitUntil, timeoutMs });
    await this.#rememberCurrent(page);
    return page;
  }

  /** Switch to a tab by targetId or URL substring (attach only, no activation). */
  async use(targetIdOrUrlSubstring) {
    const targets = await this.transport.send("Target.getTargets", {}, { timeoutMs: 5_000 });
    const match = (targets.targetInfos || []).find((target) => target.targetId === targetIdOrUrlSubstring)
      || (targets.targetInfos || []).find((target) => String(target.url || "").includes(String(targetIdOrUrlSubstring)));
    if (!match) throw elementNotFound(String(targetIdOrUrlSubstring), { kind: "tab" });
    const page = await this.attach(match.targetId);
    await this.#rememberCurrent(page);
    await this.#ensureMarker(page);
    return page;
  }

  /** Close a tab; only tabs created by this harness unless `force` is set. */
  async closeTab(targetId, { force = false } = {}) {
    const state = await this.#currentState();
    const id = targetId || (state.current && state.current.targetId);
    if (!id) throw noTab("no tab to close; pass a targetId");
    const owned = state.ownedTabs.some((tab) => tab.targetId === id);
    if (!owned && !force) throw policyDenied("refusing to close a tab this harness did not create; pass force:true explicitly", { targetId: id });
    await this.transport.send("Target.closeTarget", { targetId: id }, { timeoutMs: 5_000 });
    await stateStore.forgetTab(this.lane, id, this.config.stateDir);
    return { ok: true, closed: id };
  }

  /** Explicitly bring a tab to the foreground (user-requested only). */
  async activate(targetId) {
    const id = targetId || ((await this.#currentState()).current || {}).targetId;
    if (!id) throw noTab("activate needs a targetId");
    await this.transport.send("Target.activateTarget", { targetId: id }, { timeoutMs: 5_000 });
    return { ok: true, activated: id };
  }

  /** Browser-scoped download behavior. */
  async setDownloadBehavior({ behavior = "default", downloadPath, eventsEnabled = false } = {}) {
    const params = { behavior };
    if (downloadPath) params.downloadPath = downloadPath;
    if (eventsEnabled) params.eventsEnabled = true;
    return this.transport.send("Browser.setDownloadBehavior", params, { timeoutMs: 5_000 });
  }

  /** Re-read the attached tab and persist its url/title. */
  async #rememberCurrent(page) {
    let info = null;
    try {
      info = await page.info();
    } catch {
      info = null;
    }
    await stateStore.setCurrent(this.lane, {
      targetId: page.targetId,
      url: info ? info.url : undefined,
      title: info ? info.title : undefined,
      attachedAt: new Date().toISOString(),
    }, this.config.stateDir);
  }

  /** Mark harness-owned tabs in the title so a later call can find them. */
  async #ensureMarker(page) {
    if (this.config.marker === false) return;
    const state = await this.#currentState();
    const owned = state.ownedTabs.some((tab) => tab.targetId === page.targetId);
    if (!owned) return;
    try {
      await page.evaluate((marker) => {
        if (document.title && !document.title.startsWith(marker)) document.title = marker + " " + document.title;
      }, { args: [this.config.marker] });
    } catch { /* marker is best-effort */ }
  }

  /** Close the transport. */
  close() {
    this.transport.close();
  }
}

export { Page };
