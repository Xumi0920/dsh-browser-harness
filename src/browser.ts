/**
 * Browser-level orchestration: endpoint discovery, targets, tab ownership, and
 * the daemon-less current-tab model (state file + cached per-target Page).
 */

import { join } from "node:path";
import { CDPTransport } from "./cdp/transport.js";
import { resolveEndpoint } from "./cdp/endpoint.js";
import { Page } from "./page.js";
import * as stateStore from "./state.js";
import { TabGroupBridge, tabGroupColorFor, tabGroupTitleFor } from "./tabgroups.js";
import { badArgument, elementNotFound, noTab, policyDenied, targetGone } from "./errors.js";

const INTERNAL_URL = /^(chrome|devtools|edge|about:blank|chrome-extension):/;
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Only real web pages may be opened through the high-level API. Local file://,
 * data:, javascript: and browser-internal schemes would let a tool read files
 * outside the CDP sandbox or control browser UI, so they are rejected.
 */
export function assertNavigableUrl(url) {
  const raw = String(url ?? "");
  if (raw === "about:blank") return raw;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw badArgument(`invalid URL: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw policyDenied(`refusing to open a ${parsed.protocol} URL; only http(s) pages and about:blank are allowed`, { url: raw });
  }
  return raw;
}

function isRealPage(target) {
  return target && target.type === "page" && !INTERNAL_URL.test(String(target.url || "")) && !String(target.url || "").includes("omnibox-popup");
}

/** One connection to one running Chromium-based browser instance. */
export class Browser {
  transport: any;
  endpoint: any;
  lane: string;
  config: any;
  version: any;
  pages: Map<string, any>;
  tabGroups: any;
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
    /** @type {Map<string, Page>} one reused Page per target (CDP session) */
    this.pages = new Map();
    /** Chrome tab groups for harness-created tabs (per DSH session/task). */
    this.tabGroups = new TabGroupBridge(this, {
      enabled: this.config.tabGroups !== false,
      extensionPath: this.config.extensionPath,
      extensionId: this.config.extensionId,
    });
  }

  /**
   * Connect to a running browser.
   * @param {{
   *   ws?: string, cdpUrl?: string, browser?: string, lane?: string,
   *   stateDir?: string, downloadDir?: string, dialogPolicy?: string,
   *   fetchImpl?: typeof fetch, WebSocketImpl?: any, timeoutMs?: number,
   * }} [options]
   */
  static async connect(options = {} as any) {
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
        tabGroups: options.tabGroups,
        tabGroupTitle: options.tabGroupTitle,
        tabGroupColor: options.tabGroupColor,
        extensionPath: options.extensionPath,
        extensionId: options.extensionId,
      },
    });
    browser.version = await browser.transport.send("Browser.getVersion", {}, { timeoutMs: 5_000 }).catch(() => null);
    return browser;
  }

  /** All real page targets, with `owned` reflecting harness-created tabs. */
  async listTabs({ lane = this.lane, includeChrome = false } = {} as any) {
    const result = await this.transport.send("Target.getTargets", {}, { timeoutMs: 5_000 });
    const targets = (result.targetInfos || []).filter((target) => target.type === "page");
    await this.#prunePages(new Set(targets.map((target) => target.targetId)));
    const filtered = includeChrome ? targets : targets.filter((target) => isRealPage(target) || target.url === "about:blank");
    const state = await stateStore.readState(lane, this.config.stateDir);
    const owned = new Set(state.ownedTabs.map((tab) => tab.targetId));
    return filtered.map((target) => ({ targetId: target.targetId, url: target.url, title: target.title, owned: owned.has(target.targetId) }));
  }

  async #currentState(lane) {
    return stateStore.readState(lane, this.config.stateDir);
  }

  /** The remembered current tab, validated against live targets. */
  async current(lane = this.lane) {
    const state = await this.#currentState(lane);
    if (!state.current) return null;
    const targets = await this.transport.send("Target.getTargets", {}, { timeoutMs: 5_000 }).catch(() => ({ targetInfos: [] }));
    const infos = targets.targetInfos || [];
    await this.#prunePages(new Set(infos.map((target) => target.targetId)));
    const live = infos.find((target) => target.targetId === state.current.targetId);
    if (!live) return null;
    return { targetId: live.targetId, url: live.url, title: live.title };
  }

  /** Attach to a target, reusing the cached Page (one CDP session per tab). */
  async attach(targetId) {
    const cached = this.pages.get(targetId);
    if (cached && !cached.closed) return cached;
    let result;
    try {
      result = await this.transport.send("Target.attachToTarget", { targetId, flatten: true }, { timeoutMs: 5_000 });
    } catch (error) {
      if (/No target|target.*(closed|not found)|Session with given id not found/i.test(String(error.message))) throw targetGone(targetId);
      throw error;
    }
    const page = new Page(this, { sessionId: result.sessionId, targetId });
    await page.enableDomains();
    this.pages.set(targetId, page);
    return page;
  }

  /** Detach and forget the cached Page for a target. */
  async #dropPage(targetId) {
    const page = this.pages.get(targetId);
    if (!page) return;
    this.pages.delete(targetId);
    try {
      await page.detach();
    } catch {
      /* already gone */
    }
  }

  /** Drop cached Pages whose target no longer exists (e.g. closed elsewhere). */
  async #prunePages(liveTargetIds) {
    for (const targetId of [...this.pages.keys()]) {
      if (!liveTargetIds.has(targetId)) await this.#dropPage(targetId);
    }
  }

  /** Reuse the remembered tab when it matches, otherwise open a new one. */
  async open(url, { newTab = false, waitUntil = "load", timeoutMs = 30_000, lane = this.lane } = {} as any) {
    if (typeof url !== "string" || url.length === 0) throw badArgument("open(url) needs a URL");
    assertNavigableUrl(url);
    if (!newTab) {
      const existing = await this.current(lane);
      if (existing) {
        const page = await this.attach(existing.targetId);
        await page.navigate(url, { waitUntil, timeoutMs });
        await this.#rememberCurrent(page, lane);
        return page;
      }
    }
    return this.newTab(url, { waitUntil, timeoutMs, lane });
  }

  /** Create a background tab (never foregrounded) and optionally navigate it. */
  async newTab(url = "about:blank", { waitUntil = "load", timeoutMs = 30_000, lane = this.lane } = {} as any) {
    assertNavigableUrl(url);
    const created = await this.transport.send("Target.createTarget", { url: "about:blank", background: true }, { timeoutMs: 10_000 });
    const page = await this.attach(created.targetId);
    await stateStore.rememberOwnedTab(lane, { targetId: created.targetId, url: "about:blank" }, this.config.stateDir);
    if (url && url !== "about:blank") await page.navigate(url, { waitUntil, timeoutMs });
    await this.#rememberCurrent(page, lane);
    await this.#groupOwnedTab(page, lane);
    return page;
  }

  /**
   * Put a harness-created tab into the task's Chrome tab group (best effort).
   * User/work tabs are never touched: only the tab just created is grouped.
   */
  async #groupOwnedTab(page, lane) {
    if (this.config.tabGroups === false) return;
    try {
      const state = await stateStore.readState(lane, this.config.stateDir);
      const remembered = state.group && Number.isFinite(state.group.id) ? state.group.id : null;
      const groupId = remembered !== null && (await this.tabGroups.groupExists(remembered)) ? remembered : null;
      const title = tabGroupTitleFor(lane, this.config.tabGroupTitle);
      const color = this.config.tabGroupColor || tabGroupColorFor(lane);
      const result = await this.tabGroups.groupTab(page, { title, color, groupId });
      if (result && result.ok && Number.isFinite(result.groupId) && result.groupId !== remembered) {
        await stateStore.setGroup(lane, { id: result.groupId, title, color }, this.config.stateDir);
      }
    } catch {
      /* grouping is best-effort and must never break tab creation */
    }
  }

  /** Switch to a tab by targetId or URL substring (attach only, no activation). */
  async use(targetIdOrUrlSubstring, { lane = this.lane } = {} as any) {
    const targets = await this.transport.send("Target.getTargets", {}, { timeoutMs: 5_000 });
    const match = (targets.targetInfos || []).find((target) => target.targetId === targetIdOrUrlSubstring)
      || (targets.targetInfos || []).find((target) => String(target.url || "").includes(String(targetIdOrUrlSubstring)));
    if (!match) throw elementNotFound(String(targetIdOrUrlSubstring), { kind: "tab" });
    const page = await this.attach(match.targetId);
    await this.#rememberCurrent(page, lane);
    await this.#ensureMarker(page, lane);
    return page;
  }

  /** Close a tab; only tabs created by this harness unless `force` is set. */
  async closeTab(targetId, { force = false, lane = this.lane } = {} as any) {
    const state = await this.#currentState(lane);
    const id = targetId || (state.current && state.current.targetId);
    if (!id) throw noTab("no tab to close; pass a targetId");
    const owned = state.ownedTabs.some((tab) => tab.targetId === id);
    if (!owned && !force) throw policyDenied("refusing to close a tab this harness did not create; pass force:true explicitly", { targetId: id });
    await this.transport.send("Target.closeTarget", { targetId: id }, { timeoutMs: 5_000 });
    await stateStore.forgetTab(lane, id, this.config.stateDir);
    await this.#dropPage(id);
    return { ok: true, closed: id };
  }

  /** Explicitly bring a tab to the foreground (user-requested only). */
  async activate(targetId, { lane = this.lane } = {} as any) {
    const id = targetId || ((await this.#currentState(lane)).current || {}).targetId;
    if (!id) throw noTab("activate needs a targetId");
    await this.transport.send("Target.activateTarget", { targetId: id }, { timeoutMs: 5_000 });
    return { ok: true, activated: id };
  }

  /** Browser-scoped download behavior. */
  async setDownloadBehavior({ behavior = "default", downloadPath, eventsEnabled = false } = {} as any) {
    const params: any = { behavior };
    if (downloadPath) params.downloadPath = downloadPath;
    if (eventsEnabled) params.eventsEnabled = true;
    return this.transport.send("Browser.setDownloadBehavior", params, { timeoutMs: 5_000 });
  }

  /** Re-read the attached tab and persist its url/title for one lane. */
  async #rememberCurrent(page, lane) {
    let info = null;
    try {
      info = await page.info();
    } catch {
      info = null;
    }
    await stateStore.setCurrent(lane, {
      targetId: page.targetId,
      url: info ? info.url : undefined,
      title: info ? info.title : undefined,
      attachedAt: new Date().toISOString(),
    }, this.config.stateDir);
  }

  /** Mark harness-owned tabs in the title so a later call can find them. */
  async #ensureMarker(page, lane) {
    if (this.config.marker === false) return;
    const state = await this.#currentState(lane);
    const owned = state.ownedTabs.some((tab) => tab.targetId === page.targetId);
    if (!owned) return;
    try {
      await page.evaluate((marker) => {
        if (document.title && !document.title.startsWith(marker)) document.title = marker + " " + document.title;
      }, { args: [this.config.marker] });
    } catch { /* marker is best-effort */ }
  }

  /** Detach every cached Page and the tab-group worker, then close the transport. */
  async close() {
    const pages = [...this.pages.values()];
    this.pages.clear();
    await this.tabGroups.dispose().catch(() => {});
    await Promise.all(pages.map((page) => page.detach().catch(() => {})));
    this.transport.close();
  }
}

export { Page };