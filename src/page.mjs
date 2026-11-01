/**
 * Page-level helpers on top of one flat CDP session.
 *
 * Every method maps to plain CDP calls; no hidden daemon and no persistent
 * background listeners beyond the lifetime of this Page object.
 */

import { writeFile, readFile, readdir, stat, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  badArgument,
  dialogOpen,
  downloadFailed,
  elementNotFound,
  evalFailure,
  frameNotFound,
  selectorTimeout,
  uploadFailed,
  waitTimeout,
} from "./errors.mjs";
import { buildSnapshot, boxCenter, findRef } from "./ax.mjs";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_LOAD_TIMEOUT_MS = 30_000;

/** US physical layout for printable ASCII (enough for agent key presses). */
const KEY_CODES = {
  Enter: { code: "Enter", key: "Enter", vk: 13, text: "\r" },
  Tab: { code: "Tab", key: "Tab", vk: 9 },
  Escape: { code: "Escape", key: "Escape", vk: 27 },
  Backspace: { code: "Backspace", key: "Backspace", vk: 8 },
  Delete: { code: "Delete", key: "Delete", vk: 46 },
  ArrowUp: { code: "ArrowUp", key: "ArrowUp", vk: 38 },
  ArrowDown: { code: "ArrowDown", key: "ArrowDown", vk: 40 },
  ArrowLeft: { code: "ArrowLeft", key: "ArrowLeft", vk: 37 },
  ArrowRight: { code: "ArrowRight", key: "ArrowRight", vk: 39 },
  Home: { code: "Home", key: "Home", vk: 36 },
  End: { code: "End", key: "End", vk: 35 },
  PageUp: { code: "PageUp", key: "PageUp", vk: 33 },
  PageDown: { code: "PageDown", key: "PageDown", vk: 34 },
  Space: { code: "Space", key: " ", vk: 32, text: " " },
};

function modifierMask(modifiers) {
  if (!modifiers) return 0;
  if (Array.isArray(modifiers)) {
    let mask = 0;
    for (const name of modifiers) {
      if (name === "Alt") mask |= 1;
      else if (name === "Control" || name === "Ctrl") mask |= 2;
      else if (name === "Meta" || name === "Command") mask |= 4;
      else if (name === "Shift") mask |= 8;
    }
    return mask;
  }
  return Number(modifiers) || 0;
}

function pngSize(buffer) {
  if (!buffer || buffer.length < 24) return null;
  const signature = buffer.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function jsonSafe(value) {
  if (value === undefined) return null;
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return null;
    return JSON.parse(text);
  } catch {
    return String(value);
  }
}

export class Page {
  /**
   * @param {import("./browser.mjs").Browser} browser
   * @param {{ sessionId: string, targetId: string }} ids
   */
  constructor(browser, ids) {
    this.browser = browser;
    this.transport = browser.transport;
    this.sessionId = ids.sessionId;
    this.targetId = ids.targetId;
    /** @type {any[] | null} */
    this.lastSnapshot = null;
    /** @type {any | null} */
    this.pendingDialog = null;
    /** @type {any[]} */
    this.dialogHistory = [];
    /** @type {any[]} */
    this.networkLog = [];
    this.networkEnabled = false;
    this.dialogPolicy = browser.config.dialogPolicy ?? "auto-dismiss";
    this.focusEmulation = browser.config.focusEmulation !== false;
    this.downloadDir = browser.config.downloadDir;
    /** @type {any[]} */
    this.executionContexts = [];
    this.runtimeEnabled = false;
    /** @type {any[]} */
    this.ownedListeners = [];
  }

  /** Send a CDP command on this page session. */
  send(method, params = {}, options = {}) {
    return this.transport.send(method, params, { sessionId: this.sessionId, ...options });
  }

  /** Subscribe to page-scoped CDP events. */
  on(method, handler) {
    const off = this.transport.onEvent(method, (params, sessionId) => {
      if (sessionId === undefined || sessionId === this.sessionId) handler(params);
    });
    this.ownedListeners.push(off);
    return off;
  }

  /** Enable the CDP domains this harness depends on. */
  async enableDomains({ runtime = true } = {}) {
    const domains = [this.send("Page.enable", {}, { timeoutMs: 5_000 }).catch(() => null), this.send("DOM.enable", {}, { timeoutMs: 5_000 }).catch(() => null)];
    if (runtime && !this.runtimeEnabled) {
      this.runtimeEnabled = true;
      domains.push(
        this.send("Runtime.enable", {}, { timeoutMs: 5_000 }).catch(() => null),
      );
      this.on("Runtime.executionContextCreated", (params) => {
        if (params && params.context) this.executionContexts.push(params.context);
      });
      this.on("Runtime.executionContextDestroyed", (params) => {
        this.executionContexts = this.executionContexts.filter((context) => context.id !== (params && params.executionContextId));
      });
    }
    this.on("Page.javascriptDialogOpening", (params) => this.#onDialogOpening(params));
    this.on("Page.javascriptDialogClosed", () => {
      this.pendingDialog = null;
    });
    await Promise.all(domains);
    if (this.focusEmulation) await this.setFocusEmulation(true).catch(() => {});
    return this;
  }

  /**
   * Pretend the page has focus so CDP input is dispatched while the tab stays
   * in the background (headless and hidden tabs otherwise hang on Input.*).
   */
  async setFocusEmulation(enabled) {
    await this.send("Emulation.setFocusEmulationEnabled", { enabled: Boolean(enabled) }, { timeoutMs: 5_000 });
    this.focusEmulation = Boolean(enabled);
    return { ok: true, focusEmulation: this.focusEmulation };
  }

  #onDialogOpening(params) {
    const dialog = { type: params.type, message: params.message, defaultPrompt: params.defaultPrompt, openedAt: new Date().toISOString() };
    this.dialogHistory.push(dialog);
    if (this.dialogPolicy === "auto-dismiss") {
      this.pendingDialog = null;
      this.send("Page.handleJavaScriptDialog", { accept: false }, { timeoutMs: 5_000 }).catch(() => {});
    } else {
      this.pendingDialog = dialog;
    }
  }

  /** Pending dialog (manual policy only). */
  dialog() {
    return this.pendingDialog;
  }

  /** Handle the currently open dialog. */
  async handleDialog({ accept = true, promptText } = {}) {
    const params = { accept };
    if (typeof promptText === "string") params.promptText = promptText;
    await this.send("Page.handleJavaScriptDialog", params, { timeoutMs: 5_000 });
    this.pendingDialog = null;
    return { ok: true, accepted: accept };
  }

  /** Current url, title, readiness, viewport, scroll and page size. */
  async info() {
    const result = await this.evaluate(() => ({
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
      scroll: { x: window.scrollX, y: window.scrollY },
      page: { width: document.documentElement ? document.documentElement.scrollWidth : 0, height: document.documentElement ? document.documentElement.scrollHeight : 0 },
    }));
    return { targetId: this.targetId, ...(result || {}) };
  }

  /**
   * Evaluate an expression or a function in the main world.
   * @param {string | Function} expressionOrFn
   * @param {{ awaitPromise?: boolean, timeoutMs?: number, returnByValue?: boolean, contextId?: number }} [options]
   */
  async evaluate(expressionOrFn, options = {}) {
    if (this.pendingDialog) throw dialogOpen(this.pendingDialog);
    const callArgs = options.args === undefined ? null : JSON.stringify(options.args);
    const expression = typeof expressionOrFn === "function"
      ? "(" + expressionOrFn.toString() + ").apply(null, " + (callArgs === null ? "[]" : callArgs) + ")"
      : String(expressionOrFn);
    const params = {
      expression,
      returnByValue: options.returnByValue !== false,
      awaitPromise: options.awaitPromise !== false,
      userGesture: true,
      includeCommandLineAPI: false,
    };
    if (options.contextId) params.contextId = options.contextId;
    const result = await this.send("Runtime.evaluate", params, { timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS });
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      const exception = details.exception || {};
      throw evalFailure(expression, { message: exception.description || details.text || "JS exception", stack: details.stackTrace });
    }
    return jsonSafe(result.result ? result.result.value : null);
  }

  /** Navigate and optionally wait for the load state. */
  async navigate(url, { waitUntil = "load", timeoutMs = DEFAULT_LOAD_TIMEOUT_MS } = {}) {
    if (typeof url !== "string" || url.length === 0) throw badArgument("navigate(url) needs a URL");
    const result = await this.send("Page.navigate", { url }, { timeoutMs });
    if (result.errorText && !/^net::ERR_ABORTED/.test(result.errorText)) {
      throw new Error("navigation failed: " + result.errorText);
    }
    if (waitUntil !== "none") await this.waitForLoad({ timeoutMs });
    this.lastSnapshot = null;
    return this.info();
  }

  /** Poll document.readyState until it reaches `complete`. */
  async waitForLoad({ timeoutMs = DEFAULT_LOAD_TIMEOUT_MS } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const ready = await this.evaluate("document.readyState");
        if (ready === "complete" || ready === "interactive") return { ok: true, readyState: ready };
      } catch (error) {
        if (error.code === "E_DIALOG_OPEN") throw error;
      }
      if (Date.now() > deadline) throw waitTimeout("document.readyState === 'complete'", timeoutMs);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
  }

  /**
   * Accessibility snapshot with stable refs and optional box centers.
   * @param {{ maxNodes?: number, includeBoxes?: boolean, roles?: string[] }} [options]
   */
  async snapshot(options = {}) {
    const raw = await this.send("Accessibility.getFullAXTree", {}, { timeoutMs: 15_000 });
    const first = buildSnapshot(raw.nodes || [], { maxNodes: options.maxNodes ?? 400, roles: options.roles });
    const withBoxes = options.includeBoxes !== false;
    if (withBoxes) {
      const boxes = new Map();
      const concurrency = 8;
      for (let index = 0; index < first.nodes.length; index += concurrency) {
        const chunk = first.nodes.slice(index, index + concurrency);
        await Promise.all(chunk.map(async (node) => {
          try {
            const model = await this.send("DOM.getBoxModel", { backendNodeId: node.backendDOMNodeId }, { timeoutMs: 2_000 });
            boxes.set(node.backendDOMNodeId, model.model);
          } catch {
            /* offscreen or detached: keep the node without a box */
          }
        }));
      }
      const second = buildSnapshot(raw.nodes || [], { maxNodes: first.nodes.length, roles: options.roles, boxes });
      this.lastSnapshot = second.nodes;
      return { ...second, targetId: this.targetId };
    }
    this.lastSnapshot = first.nodes;
    return { ...first, targetId: this.targetId };
  }

  /** Resolve a snapshot ref, or take a fresh snapshot when it is missing. */
  async #resolveRef(ref) {
    if (!this.lastSnapshot) await this.snapshot();
    let node = findRef(this.lastSnapshot, ref);
    if (!node) {
      await this.snapshot();
      node = findRef(this.lastSnapshot, ref);
    }
    if (!node) throw elementNotFound(ref, { kind: "ref", refs: (this.lastSnapshot || []).slice(0, 20).map((item) => item.ref) });
    return node;
  }

  /** Resolve a CSS selector to a backend node id. */
  async #resolveSelector(selector) {
    const document = await this.send("DOM.getDocument", { depth: 0 }, { timeoutMs: 5_000 });
    try {
      const found = await this.send("DOM.querySelector", { nodeId: document.root.nodeId, selector }, { timeoutMs: 5_000 });
      if (!found || !found.nodeId) throw elementNotFound(selector);
      const described = await this.send("DOM.describeNode", { nodeId: found.nodeId }, { timeoutMs: 5_000 });
      return described.node.backendNodeId;
    } catch (error) {
      if (error.code === "E_ELEMENT_NOT_FOUND") throw error;
      throw elementNotFound(selector);
    }
  }

  async #centerForBackendNode(backendNodeId) {
    try {
      await this.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }, { timeoutMs: 3_000 });
    } catch {
      /* already visible or detached */
    }
    const model = await this.send("DOM.getBoxModel", { backendNodeId }, { timeoutMs: 5_000 });
    const center = boxCenter(model.model);
    if (!center) throw elementNotFound("backendNodeId " + backendNodeId, { kind: "box" });
    return center;
  }

  /**
   * Click by ref, selector or viewport coordinates.
   * @param {{ ref?: string, selector?: string, at?: {x:number,y:number} }} target
   * @param {{ button?: string, clicks?: number, timeoutMs?: number }} [options]
   */
  async click(target, options = {}) {
    let point = null;
    if (target && target.at) {
      point = { x: Number(target.at.x), y: Number(target.at.y) };
    } else if (target && target.ref) {
      const node = await this.#resolveRef(target.ref);
      point = await this.#centerForBackendNode(node.backendDOMNodeId);
    } else if (target && target.selector) {
      const backendNodeId = await this.#resolveSelector(target.selector);
      point = await this.#centerForBackendNode(backendNodeId);
    }
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw badArgument("click needs {ref}, {selector} or {at:{x,y}}");
    await this.clickAt(point.x, point.y, options);
    return { ok: true, x: point.x, y: point.y };
  }

  /** Dispatch a real mouse click at viewport CSS coordinates. */
  async clickAt(x, y, { button = "left", clicks = 1 } = {}) {
    const mouseButton = String(button).toLowerCase();
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, { timeoutMs: 5_000 });
    for (let index = 1; index <= clicks; index += 1) {
      await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: mouseButton, clickCount: index }, { timeoutMs: 5_000 });
      await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: mouseButton, clickCount: index }, { timeoutMs: 5_000 });
    }
    return { ok: true, x, y };
  }

  /** Focus an element by ref or selector. */
  async focus(target) {
    let backendNodeId;
    if (target && target.ref) backendNodeId = (await this.#resolveRef(target.ref)).backendDOMNodeId;
    else if (target && target.selector) backendNodeId = await this.#resolveSelector(target.selector);
    else throw badArgument("focus needs {ref} or {selector}");
    await this.send("DOM.focus", { backendNodeId }, { timeoutMs: 5_000 });
    return { ok: true };
  }

  /** Insert text into the focused element (fast path, IME friendly). */
  async type(text) {
    await this.send("Input.insertText", { text: String(text) }, { timeoutMs: 10_000 });
    return { ok: true, typed: String(text).length };
  }

  /** Press a key with optional modifiers. */
  async press(key, { modifiers = 0 } = {}) {
    const spec = KEY_CODES[key] || (key.length === 1 ? { code: /[a-z]/i.test(key) ? "Key" + key.toUpperCase() : key, key, vk: key.toUpperCase().charCodeAt(0), text: key } : null);
    if (!spec) throw badArgument("unsupported key: " + key);
    const mask = modifierMask(modifiers);
    const base = { modifiers: mask, key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk };
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base }, { timeoutMs: 5_000 });
    if (spec.text) await this.send("Input.dispatchKeyEvent", { type: "char", ...base, text: spec.text, unmodifiedText: spec.text }, { timeoutMs: 5_000 });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, { timeoutMs: 5_000 });
    return { ok: true, key };
  }

  /**
   * Fill an input like a user: real key presses plus synthetic input/change,
   * which keeps React/Vue controlled components in sync.
   */
  async fill({ ref, selector, text, clearFirst = true }, options = {}) {
    const value = String(text ?? "");
    const target = await this.#resolveTargetHandle({ ref, selector });
    await this.send("DOM.focus", { backendNodeId: target.backendNodeId }, { timeoutMs: 5_000 });
    if (clearFirst) {
      const modifiers = 2; // Control
      const selectAll = { modifiers, key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 };
      await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...selectAll }, { timeoutMs: 5_000 });
      await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...selectAll }, { timeoutMs: 5_000 });
      await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 }, { timeoutMs: 5_000 });
      await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 }, { timeoutMs: 5_000 });
    }
    await this.send("Input.insertText", { text: value }, { timeoutMs: 10_000 });
    if (target.objectId) {
      const expression = "(() => { const el = this; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return el.value; })()";
      await this.send("Runtime.callFunctionOn", { objectId: target.objectId, functionDeclaration: "function () { this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true })); return this.value; }", returnByValue: true }, { timeoutMs: 5_000 });
    }
    return { ok: true, length: value.length, ...(options.verify ? { value: await this.evaluate("document.activeElement ? document.activeElement.value : null") } : {}) };
  }

  async #resolveTargetHandle(target) {
    if (target && target.ref) {
      const node = await this.#resolveRef(target.ref);
      const resolved = await this.send("DOM.resolveNode", { backendNodeId: node.backendDOMNodeId }, { timeoutMs: 5_000 });
      return { backendNodeId: node.backendDOMNodeId, objectId: resolved.object && resolved.object.objectId };
    }
    if (target && target.selector) {
      const backendNodeId = await this.#resolveSelector(target.selector);
      const resolved = await this.send("DOM.resolveNode", { backendNodeId }, { timeoutMs: 5_000 });
      return { backendNodeId, objectId: resolved.object && resolved.object.objectId };
    }
    throw badArgument("expected {ref} or {selector}");
  }

  /** Wheel scroll at a point (defaults to the current viewport center). */
  async scroll({ dx = 0, dy = 0, x, y } = {}) {
    const info = await this.evaluate(() => ({ cx: Math.floor(window.innerWidth / 2), cy: Math.floor(window.innerHeight / 2) }));
    const pointX = typeof x === "number" ? x : info.cx;
    const pointY = typeof y === "number" ? y : info.cy;
    await this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: pointX, y: pointY, deltaX: dx, deltaY: dy }, { timeoutMs: 5_000 });
    return { ok: true, dx, dy };
  }

  /** Poll a selector until it exists (and is visible). */
  async waitForSelector(selector, { timeoutMs = DEFAULT_TIMEOUT_MS, visible = false } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const found = await this.evaluate((args) => {
          const element = document.querySelector(args.selector);
          if (!element) return null;
          if (args.visible && typeof element.checkVisibility === "function" && !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return null;
          const rect = element.getBoundingClientRect();
          return { tag: element.tagName.toLowerCase(), text: (element.innerText || "").slice(0, 200), width: rect.width, height: rect.height };
        }, { args: [{ selector, visible }] });
        if (found) return found;
      } catch (error) {
        lastError = error;
        if (error.code === "E_DIALOG_OPEN") throw error;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    throw selectorTimeout(selector, timeoutMs, { lastError: lastError ? String(lastError.message || lastError) : undefined });
  }

  /** Poll an expression until it is truthy. */
  async waitForFunction(expression, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const value = await this.evaluate(expression);
        if (value) return value;
      } catch (error) {
        if (error.code === "E_DIALOG_OPEN") throw error;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    throw waitTimeout(String(expression).slice(0, 200), timeoutMs);
  }

  /** Wait until network activity has been quiet for `idleMs`. */
  async waitForNetworkIdle({ timeoutMs = 10_000, idleMs = 500 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastCount = this.networkLog.length;
    let lastChange = Date.now();
    while (Date.now() < deadline) {
      if (this.networkLog.length !== lastCount) {
        lastCount = this.networkLog.length;
        lastChange = Date.now();
      }
      if (Date.now() - lastChange >= idleMs) return { ok: true, events: this.networkLog.length };
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    throw waitTimeout("network idle", timeoutMs);
  }

  /** Read visible text of the page or of one element. */
  async text(selector) {
    if (!selector) return this.evaluate("document.body ? document.body.innerText : ''");
    return this.evaluate((selectorArg) => {
      const element = document.querySelector(selectorArg);
      return element ? element.innerText : null;
    }, { args: [String(selector)] });
  }

  /** Capture a PNG screenshot and return its path and pixel size. */
  async screenshot({ path: filePath, fullPage = false } = {}) {
    const result = await this.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: Boolean(fullPage) }, { timeoutMs: 60_000 });
    const buffer = Buffer.from(result.data, "base64");
    const target = filePath ? resolve(filePath) : join(tmpdir(), "bh-shot-" + Date.now() + ".png");
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, buffer);
    const size = pngSize(buffer);
    return { path: target, bytes: buffer.length, width: size ? size.width : null, height: size ? size.height : null };
  }

  /** Override the viewport metrics (rendering and screenshot size). */
  async setViewport({ width, height, deviceScaleFactor = 1, mobile = false } = {}) {
    if (!Number.isFinite(width) || !Number.isFinite(height)) throw badArgument("setViewport needs numeric width and height");
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor, mobile }, { timeoutMs: 5_000 });
    return { ok: true, width, height, deviceScaleFactor };
  }

  /** Clear a previous viewport override. */
  async clearViewport() {
    await this.send("Emulation.clearDeviceMetricsOverride", {}, { timeoutMs: 5_000 });
    return { ok: true };
  }

  /** Frame tree of the page. */
  async frames() {
    const tree = await this.send("Page.getFrameTree", {}, { timeoutMs: 5_000 });
    const frames = [];
    const collect = (node, parentId) => {
      if (!node || !node.frame) return;
      frames.push({ frameId: node.frame.id, url: node.frame.url, name: node.frame.name, parentFrameId: parentId });
      for (const child of node.childFrames || []) collect(child, node.frame.id);
    };
    collect(tree.frameTree, null);
    return frames;
  }

  /** Evaluate inside a frame selected by id or URL substring. */
  async evaluateInFrame(frameMatch, expressionOrFn, options = {}) {
    const contexts = this.executionContexts;
    let context = null;
    const frames = await this.frames();
    const wanted = frames.find((frame) => (frameMatch.frameId && frame.frameId === frameMatch.frameId) || (frameMatch.urlContains && frame.url.includes(frameMatch.urlContains)));
    if (wanted) {
      for (let index = contexts.length - 1; index >= 0; index -= 1) {
        const candidate = contexts[index];
        if (candidate && candidate.auxData && candidate.auxData.frameId === wanted.frameId && candidate.auxData.isDefault) {
          context = candidate;
          break;
        }
      }
    }
    if (!context) throw frameNotFound(JSON.stringify(frameMatch));
    return this.evaluate(expressionOrFn, { ...options, contextId: context.id });
  }

  /** Start capturing network responses for this call. */
  async startNetworkCapture({ maxEvents = 2000 } = {}) {
    this.maxNetworkEvents = maxEvents;
    if (!this.networkEnabled) {
      this.networkEnabled = true;
      await this.send("Network.enable", {}, { timeoutMs: 5_000 });
      this.on("Network.requestWillBeSent", (params) => {
        this.networkLog.push({ requestId: params.requestId, url: params.request && params.request.url, method: params.request && params.request.method, resourceType: params.type, ts: Date.now() });
        if (this.networkLog.length > this.maxNetworkEvents) this.networkLog.shift();
      });
      this.on("Network.responseReceived", (params) => {
        const entry = this.networkLog.find((item) => item.requestId === params.requestId);
        if (entry) {
          entry.status = params.response && params.response.status;
          entry.mimeType = params.response && params.response.mimeType;
          entry.headers = params.response && params.response.headers;
          entry.resourceType = params.type || entry.resourceType;
        }
      });
      this.on("Network.loadingFailed", (params) => {
        const entry = this.networkLog.find((item) => item.requestId === params.requestId);
        if (entry) entry.error = params.errorText;
      });
    }
    return { ok: true, capturing: true };
  }

  /** Snapshot of captured network requests/responses. */
  networkEvents() {
    return this.networkLog.map((entry) => ({ ...entry }));
  }

  /** Wait for a response whose URL matches a string or RegExp. */
  async waitForResponse(pattern, { timeoutMs = 15_000, includeBody = false } = {}) {
    const matcher = typeof pattern === "string" ? (url) => String(url || "").includes(pattern) : (url) => pattern.test(String(url || ""));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const entry = this.networkLog.find((item) => item.status !== undefined && matcher(item.url));
      if (entry) {
        const result = { ...entry };
        if (includeBody) {
          try {
            const body = await this.send("Network.getResponseBody", { requestId: entry.requestId }, { timeoutMs: 5_000 });
            result.body = body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : body.body;
          } catch (error) {
            result.bodyError = String(error.message || error);
          }
        }
        return result;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    throw waitTimeout("response matching " + String(pattern), timeoutMs);
  }

  /** Stop network capture and return the events. */
  async stopNetworkCapture() {
    if (this.networkEnabled) {
      await this.send("Network.disable", {}, { timeoutMs: 5_000 }).catch(() => {});
      this.networkEnabled = false;
    }
    return this.networkEvents();
  }

  /** Cookies for a URL. Values are redacted unless includeValues is true. */
  async cookies({ url, includeValues = false } = {}) {
    const params = url ? { urls: [url] } : {};
    const result = await this.send("Network.getCookies", params, { timeoutMs: 5_000 });
    return (result.cookies || []).map((cookie) => ({
      name: cookie.name,
      domain: cookie.domain,
      path: cookie.path,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
      session: cookie.session,
      expires: cookie.expires,
      ...(includeValues ? { value: cookie.value } : {}),
    }));
  }

  /** Set a cookie (values never logged by the harness itself). */
  async setCookie(cookie) {
    if (!cookie || typeof cookie.name !== "string" || typeof cookie.value !== "string") throw badArgument("setCookie needs {name, value, url|domain}");
    await this.send("Network.setCookie", { ...cookie }, { timeoutMs: 5_000 });
    return { ok: true, name: cookie.name };
  }

  /** Clear cookies (all with `all`, or matching a URL). */
  async clearCookies({ url, all = false } = {}) {
    if (all) {
      const result = await this.send("Network.getAllCookies", {}, { timeoutMs: 5_000 });
      for (const cookie of result.cookies || []) {
        await this.send("Network.deleteCookies", { name: cookie.name, domain: cookie.domain, path: cookie.path }, { timeoutMs: 5_000 });
      }
      return { ok: true, cleared: (result.cookies || []).length };
    }
    if (!url) throw badArgument("clearCookies needs {url} or {all:true}");
    const result = await this.send("Network.getCookies", { urls: [url] }, { timeoutMs: 5_000 });
    for (const cookie of result.cookies || []) {
      await this.send("Network.deleteCookies", { name: cookie.name, domain: cookie.domain, path: cookie.path }, { timeoutMs: 5_000 });
    }
    return { ok: true, cleared: (result.cookies || []).length };
  }

  /**
   * Upload files to a file input.
   * @param {{ ref?: string, selector?: string }} target
   * @param {string | string[]} paths
   */
  async upload(target, paths) {
    const files = (Array.isArray(paths) ? paths : [paths]).map((file) => resolve(String(file)));
    if (files.length === 0) throw badArgument("upload needs at least one absolute file path");
    for (const file of files) {
      try {
        await stat(file);
      } catch {
        throw uploadFailed("file does not exist: " + file, { file });
      }
    }
    const handle = await this.#resolveTargetHandle(target);
    await this.send("DOM.setFileInputFiles", { files, backendNodeId: handle.backendNodeId }, { timeoutMs: 10_000 });
    return { ok: true, files };
  }

  /**
   * Click something and wait for the resulting download.
   * @param {{ dir?: string, trigger: () => Promise<any>, timeoutMs?: number }} options
   */
  async download({ dir, trigger, timeoutMs = 30_000 } = {}) {
    if (typeof trigger !== "function") throw badArgument("download needs a trigger() function");
    const directory = resolve(dir || this.downloadDir || join(this.browser.config.stateDir || tmpdir(), "downloads"));
    await mkdir(directory, { recursive: true });
    const before = new Set(await readdir(directory).catch(() => []));
    await this.browser.setDownloadBehavior({ behavior: "allow", downloadPath: directory, eventsEnabled: true });
    try {
      await trigger();
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const names = await readdir(directory).catch(() => []);
        const fresh = names.filter((name) => !before.has(name));
        const partial = fresh.filter((name) => name.endsWith(".crdownload"));
        const complete = fresh.filter((name) => !name.endsWith(".crdownload"));
        if (complete.length > 0 && partial.length === 0) {
          const file = join(directory, complete[0]);
          const info = await stat(file);
          return { ok: true, path: file, bytes: info.size, filename: complete[0] };
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
      throw downloadFailed("download did not finish within " + timeoutMs + "ms", { directory });
    } finally {
      await this.browser.setDownloadBehavior({ behavior: "default" }).catch(() => {});
    }
  }

  /** Detach listeners; the CDP session itself is released when the socket closes. */
  dispose() {
    for (const off of this.ownedListeners) {
      try { off(); } catch { /* ignore */ }
    }
    this.ownedListeners = [];
    this.lastSnapshot = null;
  }
}
