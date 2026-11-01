/**
 * Chrome tab-group bridge for harness-created tabs.
 *
 * CDP has no tab-group API, so a tiny bundled MV3 extension provides
 * chrome.tabs.group / chrome.tabGroups. The harness installs that extension in
 * the dedicated automation profile through the CDP Extensions domain, attaches
 * to its service-worker target and evaluates the grouping calls there.
 *
 * Only tabs this harness created are grouped: the extension is asked to group
 * the one tab whose title currently carries a short-lived nonce. Work tabs are
 * never listed, moved or grouped.
 */

import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

/** Colors accepted by chrome.tabGroups.update. */
export const TAB_GROUP_COLORS = Object.freeze(["blue", "cyan", "green", "orange", "pink", "purple", "red", "yellow", "grey"]);

export const TAB_GROUP_EXTENSION_NAME = "DSH Browser Harness Tab Groups";
export const TAB_GROUP_TITLE_PREFIX = "DSH · ";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Default title template; {session} is the short session/lane tag. */
export const TAB_GROUP_TITLE_TEMPLATE = TAB_GROUP_TITLE_PREFIX + "{session}";

/** Short tag used in group titles, e.g. "a1b2c3" for lane "dsh-a1b2c3". */
export function tabGroupSessionTag(lane: any) {
  const raw = String(lane || "default");
  if (raw === "default") return "default";
  const tag = raw.replace(/^dsh-/, "").replace(/[^a-zA-Z0-9]+/g, "").slice(-6);
  return tag || "default";
}

/**
 * Stable per-lane group title, e.g. "DSH · a1b2c3".
 * Supports a template with {session} and {lane} placeholders.
 */
export function tabGroupTitleFor(lane: any, template = TAB_GROUP_TITLE_TEMPLATE) {
  const raw = String(lane || "default");
  const title = String(template || TAB_GROUP_TITLE_TEMPLATE)
    .replaceAll("{session}", tabGroupSessionTag(raw))
    .replaceAll("{lane}", raw);
  return title.slice(0, 64) || TAB_GROUP_TITLE_PREFIX + tabGroupSessionTag(raw);
}

/** Deterministic group color per lane. */
export function tabGroupColorFor(lane: any) {
  let hash = 0;
  for (const character of String(lane || "default")) hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  return TAB_GROUP_COLORS[hash % TAB_GROUP_COLORS.length];
}

export class TabGroupBridge {
  browser: any;
  extensionPath: string;
  enabled: boolean;
  extensionId: string | null;
  sessionId: string | null;
  available: boolean;
  error: string | null;
  failedAt: number;
  retryDelayMs: number;
  queue: Promise<void>;
  /**
   * @param {import("./browser.js").Browser} browser
   * @param {{ enabled?: boolean, extensionPath?: string, extensionId?: string }} [options]
   */
  constructor(browser: any, options: any = {}) {
    this.browser = browser;
    this.extensionPath = options.extensionPath || fileURLToPath(new URL("../../extension", import.meta.url));
    this.enabled = options.enabled !== false;
    this.extensionId = options.extensionId || null;
    /** @type {string | null} */
    this.sessionId = null;
    this.available = false;
    this.error = null;
    /** After a failure, do not retry for a while (keeps every new tab cheap). */
    this.failedAt = 0;
    this.retryDelayMs = 60_000;
    /** @type {Promise<unknown>} */
    this.queue = Promise.resolve();
  }

  get transport() {
    return this.browser.transport;
  }

  /** Report for browser_status. */
  info() {
    return {
      enabled: this.enabled,
      available: this.available,
      extensionId: this.extensionId,
      extensionPath: this.extensionPath,
      error: this.error,
    };
  }

  /** Serialize operations: one worker session and one group state at a time. */
  run(operation: () => Promise<any>) {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  /** Install (or find) the extension and attach to its service worker. */
  async ensure() {
    if (!this.enabled) return false;
    if (this.available && this.sessionId) return true;
    if (!this.available && this.failedAt && Date.now() - this.failedAt < this.retryDelayMs) return false;
    try {
      await this.#installOrFindExtension();
      await this.#attachWorker();
      this.available = true;
      this.error = null;
      return true;
    } catch (error: any) {
      this.available = false;
      this.sessionId = null;
      this.failedAt = Date.now();
      this.error = String((error && error.message) || error);
      return false;
    }
  }

  async #installOrFindExtension() {
    const listing = await this.transport.send("Extensions.getExtensions", {}, { timeoutMs: 5_000 });
    const extensions = Array.isArray(listing && listing.extensions) ? listing.extensions : [];
    const wantedPath = resolvePath(this.extensionPath);
    const byPath = extensions.find((entry: any) => entry && typeof entry.path === "string" && resolvePath(entry.path) === wantedPath);
    if (byPath) {
      this.extensionId = byPath.id;
      return;
    }
    const stale = extensions.find((entry: any) => entry && entry.name === TAB_GROUP_EXTENSION_NAME);
    if (stale && stale.id) {
      try { await this.transport.send("Extensions.uninstall", { id: stale.id }, { timeoutMs: 5_000 }); } catch { /* ignore */ }
    }
    const loaded = await this.transport.send("Extensions.loadUnpacked", { path: wantedPath }, { timeoutMs: 15_000 });
    if (!loaded || typeof loaded.id !== "string") throw new Error("Extensions.loadUnpacked did not return an extension id");
    this.extensionId = loaded.id;
  }

  async #findWorkerTarget() {
    const targets = await this.transport.send("Target.getTargets", {}, { timeoutMs: 5_000 });
    const infos = Array.isArray(targets && targets.targetInfos) ? targets.targetInfos : [];
    return infos.find((info: any) => info && info.type === "service_worker" && String(info.url || "").startsWith("chrome-extension://" + this.extensionId + "/")) || null;
  }

  async #waitForWorkerTarget(timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const target = await this.#findWorkerTarget().catch(() => null);
      if (target) return target;
      await delay(100);
    }
    return null;
  }

  async #attachWorker() {
    this.sessionId = null;
    const target = await this.#waitForWorkerTarget(2_000);
    if (!target) throw new Error("tab-group extension worker is not running (create a tab to wake it)");
    const attached = await this.transport.send("Target.attachToTarget", { targetId: target.targetId, flatten: true }, { timeoutMs: 5_000 });
    const sessionId = attached && attached.sessionId;
    if (!sessionId) throw new Error("cannot attach to the tab-group extension worker");
    this.sessionId = sessionId;
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      try {
        const type = await this.#evalRaw("typeof chrome");
        if (type === "object") return;
      } catch { /* worker still starting */ }
      await delay(100);
    }
    this.sessionId = null;
    throw new Error("tab-group extension worker did not expose chrome APIs");
  }

  async #evalRaw(expression: string) {
    const result = await this.transport.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      { timeoutMs: 10_000, sessionId: this.sessionId },
    );
    if (result && result.exceptionDetails) {
      const details = result.exceptionDetails;
      const message = (details.exception && details.exception.description) || details.text || "extension evaluation failed";
      throw new Error(String(message).split("\n")[0]);
    }
    return result && result.result ? result.result.value : undefined;
  }

  /** Evaluate an expression in the worker, re-attaching once if it went away. */
  async evaluate(expression: string) {
    if (!this.sessionId) {
      if (!(await this.ensure())) throw new Error(this.error || "tab-group extension is unavailable");
    }
    try {
      return await this.#evalRaw(expression);
    } catch (error: any) {
      // The MV3 service worker may have been shut down: drop the stale session
      // so ensure() re-installs/re-attaches instead of short-circuiting.
      this.available = false;
      this.sessionId = null;
      if (!(await this.ensure())) throw error;
      return this.#evalRaw(expression);
    }
  }

  /** List groups (test/diagnostic helper). */
  async listGroups() {
    const ready = await this.ensure();
    if (!ready) return [];
    try {
      const groups = await this.evaluate("chrome.tabGroups.query({}).then((groups) => groups.map((group) => ({ id: group.id, title: group.title, color: group.color })))");
      return Array.isArray(groups) ? groups : [];
    } catch {
      return [];
    }
  }

  /** Whether the group still exists (empty groups are removed by Chrome). */
  async groupExists(groupId: number) {
    if (!Number.isFinite(groupId)) return false;
    const ready = await this.ensure();
    if (!ready) return false;
    try {
      const found = await this.evaluate(
        "chrome.tabGroups.get(" + Number(groupId) + ").then((group) => group.id).catch(() => null)",
      );
      return found === Number(groupId);
    } catch {
      return false;
    }
  }

  /**
   * Put one harness-created page into its task group.
   *
   * The page is briefly retitled with a nonce so the extension can find exactly
   * this tab; the original title is restored afterwards.
   *
   * @param {import("./page.js").Page} page
   * @param {{ title: string, color?: string, groupId?: number | null }} options
   */
  async groupTab(page: any, { title, color = "blue", groupId = null } = {} as any) {
    if (!this.enabled) return { ok: false, reason: "disabled" };
    return this.run(async () => {
      const ready = await this.ensure();
      if (!ready) return { ok: false, reason: "extension-unavailable", error: this.error };
      let originalTitle = "";
      try {
        originalTitle = String((await page.evaluate("document.title")) ?? "");
      } catch {
        originalTitle = "";
      }
      const nonce = "DSH-TMP-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      try {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await page.evaluate((value: any) => { document.title = value; }, { args: [nonce] }).catch(() => {});
          const wantedGroupId = Number.isFinite(groupId) ? Number(groupId) : null;
          const result = await this.evaluate(groupExpression({ nonce, title, color, groupId: wantedGroupId }));
          if (result && result.ok) return { ...result, tabId: result.tabId, groupId: result.groupId };
          await delay(100);
        }
        return { ok: false, reason: "tab-not-found" };
      } catch (error: any) {
        return { ok: false, reason: "group-failed", error: String((error && error.message) || error) };
      } finally {
        await page.evaluate((value: any) => { document.title = value; }, { args: [originalTitle] }).catch(() => {});
      }
    });
  }

  /** Reset the failure cooldown (used by tests and after an explicit retry). */
  resetFailure() {
    this.failedAt = 0;
    this.error = null;
  }

  /** Detach the worker session (the extension stays installed for later runs). */
  async dispose() {
    const sessionId = this.sessionId;
    this.sessionId = null;
    this.available = false;
    if (!sessionId) return;
    try {
      await this.transport.send("Target.detachFromTarget", { sessionId }, { timeoutMs: 2_000 });
    } catch {
      /* transport already closed */
    }
  }
}

function groupExpression({ nonce, title, color, groupId }: any) {
  return "(async () => {" +
    "const tabs = await chrome.tabs.query({ title: " + JSON.stringify(nonce) + " });" +
    "if (!tabs.length) return { ok: false, error: 'tab-not-found' };" +
    "const tab = tabs[0];" +
    "let id = " + (groupId === null ? "null" : String(Number(groupId))) + ";" +
    "let created = false;" +
    "if (typeof id === 'number') {" +
    "  try { await chrome.tabs.group({ tabIds: [tab.id], groupId: id }); } catch (error) { id = null; }" +
    "}" +
    "if (typeof id !== 'number') {" +
    "  id = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });" +
    "  created = true;" +
    "  await chrome.tabGroups.update(id, { title: " + JSON.stringify(String(title || "")) + ", color: " + JSON.stringify(String(color || "blue")) + " });" +
    "}" +
    "return { ok: true, groupId: id, tabId: tab.id, created };" +
    "})()";
}