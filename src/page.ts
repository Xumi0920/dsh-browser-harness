/**
 * Page-level helpers on top of one flat CDP session.
 *
 * Every method maps to plain CDP calls; no hidden daemon and no persistent
 * background listeners beyond the lifetime of this Page object.
 */

import { writeFile, readFile, readdir, stat, mkdir, realpath, lstat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import {
  badArgument,
  dialogOpen,
  downloadFailed,
  elementNotFound,
  evalFailure,
  frameNotFound,
  policyDenied,
  selectorTimeout,
  uploadFailed,
  waitTimeout,
} from "./errors.js";
import { buildSnapshot, boxCenter, findRef } from "./ax.js";

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

function modifierMask(modifiers: any) {
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


/** Verify every existing component of a screenshot parent before mkdir. */
async function assertSafeScreenshotParent(base: string, realBase: string, parent: string) {
  let current = base;
  let nearestExisting = base;
  for (const part of relative(base, parent).split(sep).filter(Boolean)) {
    current = join(current, part);
    let stats: any;
    try {
      stats = await lstat(current);
    } catch (error: any) {
      if (error && error.code === "ENOENT") break;
      throw policyDenied("cannot verify screenshot path", { path: current });
    }
    if (stats.isSymbolicLink()) throw policyDenied("screenshot path must not traverse symlinks or junctions", { path: current });
    if (!stats.isDirectory()) throw policyDenied("screenshot path component is not a directory", { path: current });
    nearestExisting = current;
  }
  const realNearest = await realpath(nearestExisting).catch(() => {
    throw policyDenied("cannot resolve screenshot path", { path: nearestExisting });
  });
  const relativeNearest = relative(realBase, realNearest);
  if (relativeNearest === ".." || relativeNearest.startsWith(".." + sep) || isAbsolute(relativeNearest)) {
    throw policyDenied("screenshot path must stay inside screenshotDir", { path: nearestExisting, screenshotDir: realBase });
  }
}

function pngSize(buffer: any) {
  if (!buffer || buffer.length < 24) return null;
  const signature = buffer.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function jsonSafe(value: any) {
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
  browser: any;
  transport: any;
  sessionId: string;
  targetId: string;
  lastSnapshot: any;
  nextRef: number;
  pendingDialog: any;
  dialogHistory: any[];
  networkLog: any[];
  networkEnabled: boolean;
  networkStarting: any;
  closed: boolean;
  dialogPolicy: string;
  focusEmulation: boolean;
  downloadDir: string;
  screenshotDir: string;
  executionContexts: any[];
  runtimeEnabled: boolean;
  ownedListeners: any[];
  maxNetworkEvents: number = 1000;
  /**
   * @param {import("./browser.js").Browser} browser
   * @param {{ sessionId: string, targetId: string }} ids
   */
  constructor(browser: any, ids: any) {
    this.browser = browser;
    this.transport = browser.transport;
    this.sessionId = ids.sessionId;
    this.targetId = ids.targetId;
    /** @type {any[] | null} */
    this.lastSnapshot = null;
    /** Monotonic ref counter: a stale ref never matches a later snapshot. */
    this.nextRef = 0;
    /** @type {any | null} */
    this.pendingDialog = null;
    /** @type {any[]} */
    this.dialogHistory = [];
    /** @type {any[]} */
    this.networkLog = [];
    this.networkEnabled = false;
    /** @type {any | null} */
    this.networkStarting = null;
    /** Cached page instances are detached after use; a closed page refuses work. */
    this.closed = false;
    this.dialogPolicy = browser.config.dialogPolicy ?? "auto-dismiss";
    this.focusEmulation = browser.config.focusEmulation !== false;
    this.downloadDir = browser.config.downloadDir;
    this.screenshotDir = browser.config.screenshotDir || join(browser.config.stateDir || "", "screenshots");
    /** @type {any[]} */
    this.executionContexts = [];
    this.runtimeEnabled = false;
    /** @type {any[]} */
    this.ownedListeners = [];
  }

  /** Send a CDP command on this page session. */
  send(method: any, params: any = {} as any, options: any = {} as any) {
    return this.transport.send(method, params, { sessionId: this.sessionId, ...options });
  }

  /** Subscribe to page-scoped CDP events. */
  on(method: any, handler: any) {
    const off = this.transport.onEvent(method, (params: any, sessionId: any) => {
      if (sessionId === undefined || sessionId === this.sessionId) handler(params);
    });
    this.ownedListeners.push(off);
    return off;
  }

  /** Enable the CDP domains this harness depends on. */
  async enableDomains({ runtime = true }: any = {} as any) {
    const domains = [this.send("Page.enable", {}, { timeoutMs: 5_000 }).catch(() => null), this.send("DOM.enable", {}, { timeoutMs: 5_000 }).catch(() => null)];
    if (runtime && !this.runtimeEnabled) {
      this.runtimeEnabled = true;
      domains.push(
        this.send("Runtime.enable", {}, { timeoutMs: 5_000 }).catch(() => null),
      );
      this.on("Runtime.executionContextCreated", (params: any) => {
        if (params && params.context) this.executionContexts.push(params.context);
      });
      this.on("Runtime.executionContextDestroyed", (params: any) => {
        this.executionContexts = this.executionContexts.filter((context: any) => context.id !== (params && params.executionContextId));
      });
    }
    this.on("Page.javascriptDialogOpening", (params: any) => this.#onDialogOpening(params));
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
  async setFocusEmulation(enabled: any) {
    await this.send("Emulation.setFocusEmulationEnabled", { enabled: Boolean(enabled) }, { timeoutMs: 5_000 });
    this.focusEmulation = Boolean(enabled);
    return { ok: true, focusEmulation: this.focusEmulation };
  }

  #onDialogOpening(params: any) {
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
  async handleDialog({ accept = true, promptText }: any = {} as any) {
    const params: any = { accept };
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
  async evaluate(expressionOrFn: any, options: any = {} as any) {
    if (this.pendingDialog) throw dialogOpen(this.pendingDialog);
    const callArgs = options.args === undefined ? null : JSON.stringify(options.args);
    const expression = typeof expressionOrFn === "function"
      ? "(" + expressionOrFn.toString() + ").apply(null, " + (callArgs === null ? "[]" : callArgs) + ")"
      : String(expressionOrFn);
    const params: any = {
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
  async navigate(url: any, { waitUntil = "load", timeoutMs = DEFAULT_LOAD_TIMEOUT_MS }: any = {} as any) {
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
  async waitForLoad({ timeoutMs = DEFAULT_LOAD_TIMEOUT_MS }: any = {} as any) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const ready = await this.evaluate("document.readyState");
        if (ready === "complete" || ready === "interactive") return { ok: true, readyState: ready };
      } catch (error: any) {
        if (error.code === "E_DIALOG_OPEN") throw error;
      }
      if (Date.now() > deadline) throw waitTimeout("document.readyState === 'complete'", timeoutMs);
      await new Promise((resolvePromise: any) => setTimeout(resolvePromise, 50));
    }
  }

  /**
   * Accessibility snapshot with stable refs and optional box centers.
   * @param {{ maxNodes?: number, includeBoxes?: boolean, roles?: string[] }} [options]
   */
  async snapshot(options: any = {} as any) {
    const raw = await this.send("Accessibility.getFullAXTree", {}, { timeoutMs: 15_000 });
    const refStart = this.nextRef;
    const first = buildSnapshot(raw.nodes || [], { maxNodes: options.maxNodes ?? 400, roles: options.roles, refStart });
    const withBoxes = options.includeBoxes !== false;
    if (withBoxes) {
      const boxes = new Map();
      const concurrency = 8;
      for (let index = 0; index < first.nodes.length; index += concurrency) {
        const chunk = first.nodes.slice(index, index + concurrency);
        await Promise.all(chunk.map(async (node: any) => {
          try {
            const model = await this.send("DOM.getBoxModel", { backendNodeId: node.backendDOMNodeId }, { timeoutMs: 2_000 });
            boxes.set(node.backendDOMNodeId, model.model);
          } catch {
            /* offscreen or detached: keep the node without a box */
          }
        }));
      }
      const second = buildSnapshot(raw.nodes || [], { maxNodes: first.nodes.length, roles: options.roles, boxes, refStart });
      this.lastSnapshot = second.nodes;
      this.nextRef = refStart + second.nodes.length;
      return { ...second, targetId: this.targetId };
    }
    this.lastSnapshot = first.nodes;
    this.nextRef = refStart + first.nodes.length;
    return { ...first, targetId: this.targetId };
  }

  /**
   * Resolve a snapshot ref against the latest snapshot only.
   *
   * A ref belongs to the snapshot that produced it. Re-snapshotting here would
   * silently renumber refs, so a missing ref is an error instead of a remap.
   */
  async #resolveRef(ref: any) {
    if (!this.lastSnapshot) {
      throw elementNotFound(ref, { kind: "ref", hint: "no snapshot yet; call browser_snapshot or browser_navigate first" });
    }
    const node = findRef(this.lastSnapshot, ref);
    if (!node) {
      throw elementNotFound(ref, {
        kind: "ref",
        hint: "ref is not in the latest snapshot; take a new snapshot and use its refs",
        refs: this.lastSnapshot.slice(0, 20).map((item: any) => item.ref),
      });
    }
    return node;
  }

  /** Resolve a CSS selector to a backend node id. */
  async #resolveSelector(selector: any) {
    const document = await this.send("DOM.getDocument", { depth: 0 }, { timeoutMs: 5_000 });
    try {
      const found = await this.send("DOM.querySelector", { nodeId: document.root.nodeId, selector }, { timeoutMs: 5_000 });
      if (!found || !found.nodeId) throw elementNotFound(selector);
      const described = await this.send("DOM.describeNode", { nodeId: found.nodeId }, { timeoutMs: 5_000 });
      return described.node.backendNodeId;
    } catch (error: any) {
      if (error.code === "E_ELEMENT_NOT_FOUND") throw error;
      throw elementNotFound(selector);
    }
  }

  async #centerForBackendNode(backendNodeId: any) {
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
  async click(target: any, options: any = {} as any) {
    let point: any = null;
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
  async clickAt(x: any, y: any, { button = "left", clicks = 1 }: any = {} as any) {
    const mouseButton = String(button).toLowerCase();
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, { timeoutMs: 5_000 });
    for (let index = 1; index <= clicks; index += 1) {
      await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: mouseButton, clickCount: index }, { timeoutMs: 5_000 });
      await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: mouseButton, clickCount: index }, { timeoutMs: 5_000 });
    }
    return { ok: true, x, y };
  }

  /** Focus an element by ref or selector. */
  async focus(target: any) {
    let backendNodeId;
    if (target && target.ref) backendNodeId = (await this.#resolveRef(target.ref)).backendDOMNodeId;
    else if (target && target.selector) backendNodeId = await this.#resolveSelector(target.selector);
    else throw badArgument("focus needs {ref} or {selector}");
    await this.send("DOM.focus", { backendNodeId }, { timeoutMs: 5_000 });
    return { ok: true };
  }

  /** Insert text into the focused element (fast path, IME friendly). */
  async type(text: any) {
    await this.send("Input.insertText", { text: String(text) }, { timeoutMs: 10_000 });
    return { ok: true, typed: String(text).length };
  }

  /** Press a key with optional modifiers. */
  async press(key: any, { modifiers = 0 }: any = {} as any) {
    const spec = (KEY_CODES as Record<string, any>)[key] || (key.length === 1 ? { code: /[a-z]/i.test(key) ? "Key" + key.toUpperCase() : key, key, vk: key.toUpperCase().charCodeAt(0), text: key } : null);
    if (!spec) throw badArgument("unsupported key: " + key);
    const mask = modifierMask(modifiers);
    const base = { modifiers: mask, key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk };
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base }, { timeoutMs: 5_000 });
    if (spec.text) await this.send("Input.dispatchKeyEvent", { type: "char", ...base, text: spec.text, unmodifiedText: spec.text }, { timeoutMs: 5_000 });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, { timeoutMs: 5_000 });
    return { ok: true, key };
  }

  /**
   * Fill an input: focus it, clear with real Ctrl+A / Backspace key presses,
   * write the value once with Input.insertText, then dispatch input/change so
   * React/Vue controlled components stay in sync. This is not per-character
   * typing (use type() for that).
   */
  async fill({ ref, selector, text, clearFirst = true }: any, options: any = {} as any) {
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
      await this.send("Runtime.callFunctionOn", { objectId: target.objectId, functionDeclaration: "function () { this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true })); return this.value; }", returnByValue: true }, { timeoutMs: 5_000 });
    }
    let verified: boolean | undefined;
    if (options.verify) {
      const current = await this.evaluate("document.activeElement ? document.activeElement.value : null");
      verified = String(current ?? "") === value;
    }
    return { ok: true, length: value.length, ...(verified === undefined ? {} : { verified }) };
  }

  async #resolveTargetHandle(target: any) {
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
  async scroll({ dx = 0, dy = 0, x, y }: any = {} as any) {
    const info = await this.evaluate(() => ({ cx: Math.floor(window.innerWidth / 2), cy: Math.floor(window.innerHeight / 2) }));
    const pointX = typeof x === "number" ? x : info.cx;
    const pointY = typeof y === "number" ? y : info.cy;
    await this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: pointX, y: pointY, deltaX: dx, deltaY: dy }, { timeoutMs: 5_000 });
    return { ok: true, dx, dy };
  }

  /** Poll a selector until it exists (and is visible). */
  async waitForSelector(selector: any, { timeoutMs = DEFAULT_TIMEOUT_MS, visible = false }: any = {} as any) {
    const deadline = Date.now() + timeoutMs;
    let lastError: any = null;
    while (Date.now() < deadline) {
      try {
        const found = await this.evaluate((args: any) => {
          const element = document.querySelector(args.selector);
          if (!element) return null;
          if (args.visible && typeof element.checkVisibility === "function" && !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return null;
          const rect = element.getBoundingClientRect();
          return { tag: element.tagName.toLowerCase(), text: (element.innerText || "").slice(0, 200), width: rect.width, height: rect.height };
        }, { args: [{ selector, visible }] });
        if (found) return found;
      } catch (error: any) {
        lastError = error;
        if (error.code === "E_DIALOG_OPEN") throw error;
      }
      await new Promise((resolvePromise: any) => setTimeout(resolvePromise, 50));
    }
    throw selectorTimeout(selector, timeoutMs, { lastError: lastError ? String(lastError.message || lastError) : undefined });
  }

  /** Poll an expression until it is truthy. */
  async waitForFunction(expression: any, { timeoutMs = DEFAULT_TIMEOUT_MS }: any = {} as any) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const value = await this.evaluate(expression);
        if (value) return value;
      } catch (error: any) {
        if (error.code === "E_DIALOG_OPEN") throw error;
      }
      await new Promise((resolvePromise: any) => setTimeout(resolvePromise, 50));
    }
    throw waitTimeout(String(expression).slice(0, 200), timeoutMs);
  }

  /** Wait until network activity has been quiet for `idleMs`. */
  async waitForNetworkIdle({ timeoutMs = 10_000, idleMs = 500 }: any = {} as any) {
    const deadline = Date.now() + timeoutMs;
    let lastCount = this.networkLog.length;
    let lastChange = Date.now();
    while (Date.now() < deadline) {
      if (this.networkLog.length !== lastCount) {
        lastCount = this.networkLog.length;
        lastChange = Date.now();
      }
      if (Date.now() - lastChange >= idleMs) return { ok: true, events: this.networkLog.length };
      await new Promise((resolvePromise: any) => setTimeout(resolvePromise, 50));
    }
    throw waitTimeout("network idle", timeoutMs);
  }

  /** Read visible text of the page or of one element. */
  async text(selector: any) {
    if (!selector) return this.evaluate("document.body ? document.body.innerText : ''");
    return this.evaluate((selectorArg: any) => {
      const element = document.querySelector(selectorArg);
      return element ? element.innerText : null;
    }, { args: [String(selector)] });
  }

  /**
   * Capture a PNG screenshot and return its path and pixel size.
   *
   * Files are confined to the configured screenshotDir (default
   * <stateDir>/screenshots). Relative paths resolve inside that directory, and
   * existing files are never overwritten.
   */
  async screenshot({ path: filePath, fullPage = false }: any = {} as any) {
    const result = await this.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: Boolean(fullPage) }, { timeoutMs: 60_000 });
    const buffer = Buffer.from(result.data, "base64");
    const base = resolve(this.screenshotDir);
    await mkdir(base, { recursive: true, mode: 0o700 });
    const realBase = await realpath(base).catch(() => {
      throw policyDenied("cannot resolve screenshotDir", { screenshotDir: base });
    });
    const target = filePath ? resolve(base, String(filePath)) : join(base, "bh-shot-" + Date.now() + ".png");
    const relativeTarget = relative(resolve(this.screenshotDir), target);
    if (relativeTarget === ".." || relativeTarget.startsWith(".." + sep) || isAbsolute(relativeTarget)) {
      throw policyDenied("screenshot path must stay inside screenshotDir", { path: target, screenshotDir: base });
    }
    const parent = dirname(target);
    await assertSafeScreenshotParent(base, realBase, parent);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const realParent = await realpath(parent).catch(() => {
      throw policyDenied("cannot resolve screenshot path", { path: parent });
    });
    const relativeParent = relative(realBase, realParent);
    if (relativeParent === ".." || relativeParent.startsWith(".." + sep) || isAbsolute(relativeParent)) {
      throw policyDenied("screenshot path must stay inside screenshotDir", { path: target, screenshotDir: realBase });
    }
    try {
      await writeFile(target, buffer, { flag: "wx", mode: 0o600 });
    } catch (error: any) {
      if (error && error.code === "EEXIST") throw policyDenied("refusing to overwrite an existing screenshot", { path: target });
      throw error;
    }
    const size = pngSize(buffer);
    return { path: target, bytes: buffer.length, width: size ? size.width : null, height: size ? size.height : null };
  }

  /** Override the viewport metrics (rendering and screenshot size). */
  async setViewport({ width, height, deviceScaleFactor = 1, mobile = false }: any = {} as any) {
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
    const frames: any[] = [];
    const collect = (node: any, parentId: any) => {
      if (!node || !node.frame) return;
      frames.push({ frameId: node.frame.id, url: node.frame.url, name: node.frame.name, parentFrameId: parentId });
      for (const child of node.childFrames || []) collect(child, node.frame.id);
    };
    collect(tree.frameTree, null);
    return frames;
  }

  /** Evaluate inside a frame selected by id or URL substring. */
  async evaluateInFrame(frameMatch: any, expressionOrFn: any, options: any = {} as any) {
    const contexts = this.executionContexts;
    let context: any = null;
    const frames = await this.frames();
    const wanted = frames.find((frame: any) => (frameMatch.frameId && frame.frameId === frameMatch.frameId) || (frameMatch.urlContains && frame.url.includes(frameMatch.urlContains)));
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

  /**
   * Start capturing network requests/responses on this page session.
   *
   * Idempotent: the log lives on the (cached) Page, so events survive across
   * tool calls while the tab stays attached.
   */
  async startNetworkCapture({ maxEvents = 2000 }: any = {} as any) {
    this.maxNetworkEvents = maxEvents;
    if (this.networkEnabled) return { ok: true, capturing: true };
    if (this.networkStarting) return this.networkStarting;
    const start = (async () => {
      await this.send("Network.enable", {}, { timeoutMs: 5_000 });
      this.networkEnabled = true;
      this.on("Network.requestWillBeSent", (params: any) => {
        this.networkLog.push({ requestId: params.requestId, url: params.request && params.request.url, method: params.request && params.request.method, resourceType: params.type, ts: Date.now() });
        if (this.networkLog.length > this.maxNetworkEvents) this.networkLog.shift();
      });
      this.on("Network.responseReceived", (params: any) => {
        const entry = this.networkLog.find((item: any) => item.requestId === params.requestId);
        if (entry) {
          entry.status = params.response && params.response.status;
          entry.mimeType = params.response && params.response.mimeType;
          entry.headers = params.response && params.response.headers;
          entry.resourceType = params.type || entry.resourceType;
        }
      });
      this.on("Network.loadingFailed", (params: any) => {
        const entry = this.networkLog.find((item: any) => item.requestId === params.requestId);
        if (entry) entry.error = params.errorText;
      });
      return { ok: true, capturing: true };
    })();
    this.networkStarting = start;
    try {
      return await start;
    } finally {
      this.networkStarting = null;
    }
  }

  /**
   * Attach response bodies to the most recent captured events (opt-in and slow).
   * @param {any[]} events events from networkEvents()
   * @param {{ limit?: number, maxBytes?: number }} [options]
   */
  async networkBodies(events: any, { limit = 10, maxBytes = 200_000 }: any = {} as any) {
    const out: any[] = [];
    for (const event of (events || []).slice(-limit)) {
      const entry = { ...event };
      if (entry.status !== undefined) {
        try {
          const body = await this.send("Network.getResponseBody", { requestId: entry.requestId }, { timeoutMs: 5_000 });
          const text = body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : body.body;
          if (typeof text === "string") {
            entry.bodyTruncated = text.length > maxBytes;
            entry.body = entry.bodyTruncated ? text.slice(0, maxBytes) : text;
          }
        } catch (error: any) {
          entry.bodyError = String((error && error.message) || error);
        }
      }
      out.push(entry);
    }
    return out;
  }

  /** Snapshot of captured network requests/responses. */
  networkEvents() {
    return this.networkLog.map((entry: any) => ({ ...entry }));
  }

  /** Wait for a response whose URL matches a string or RegExp. */
  async waitForResponse(pattern: any, { timeoutMs = 15_000, includeBody = false }: any = {} as any) {
    const matcher = typeof pattern === "string" ? (url: any) => String(url || "").includes(pattern) : (url: any) => pattern.test(String(url || ""));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const entry = this.networkLog.find((item: any) => item.status !== undefined && matcher(item.url));
      if (entry) {
        const result = { ...entry };
        if (includeBody) {
          try {
            const body = await this.send("Network.getResponseBody", { requestId: entry.requestId }, { timeoutMs: 5_000 });
            result.body = body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : body.body;
          } catch (error: any) {
            result.bodyError = String(error.message || error);
          }
        }
        return result;
      }
      await new Promise((resolvePromise: any) => setTimeout(resolvePromise, 50));
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
  async cookies({ url, includeValues = false }: any = {} as any) {
    const params = url ? { urls: [url] } : {};
    const result = await this.send("Network.getCookies", params, { timeoutMs: 5_000 });
    return (result.cookies || []).map((cookie: any) => ({
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
  async setCookie(cookie: any) {
    if (!cookie || typeof cookie.name !== "string" || typeof cookie.value !== "string") throw badArgument("setCookie needs {name, value, url|domain}");
    await this.send("Network.setCookie", { ...cookie }, { timeoutMs: 5_000 });
    return { ok: true, name: cookie.name };
  }

  /** Clear cookies (all with `all`, or matching a URL). */
  async clearCookies({ url, all = false }: any = {} as any) {
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
  async upload(target: any, paths: any) {
    const files = (Array.isArray(paths) ? paths : [paths]).map((file: any) => resolve(String(file)));
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
  async download({ dir, trigger, timeoutMs = 30_000 }: any = {} as any) {
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
        const fresh = names.filter((name: any) => !before.has(name));
        const partial = fresh.filter((name: any) => name.endsWith(".crdownload"));
        const complete = fresh.filter((name: any) => !name.endsWith(".crdownload"));
        if (complete.length > 0 && partial.length === 0) {
          const file = join(directory, complete[0]);
          const info = await stat(file);
          return { ok: true, path: file, bytes: info.size, filename: complete[0] };
        }
        await new Promise((resolvePromise: any) => setTimeout(resolvePromise, 100));
      }
      throw downloadFailed("download did not finish within " + timeoutMs + "ms", { directory });
    } finally {
      await this.browser.setDownloadBehavior({ behavior: "default" }).catch(() => {});
    }
  }

  /** Drop this page's listeners and cached snapshot state. */
  dispose() {
    for (const off of this.ownedListeners) {
      try { off(); } catch { /* ignore */ }
    }
    this.ownedListeners = [];
    this.lastSnapshot = null;
  }

  /**
   * Release this page: drop listeners and detach its CDP session.
   * The Page object is unusable afterwards.
   */
  async detach() {
    if (this.closed) return;
    this.closed = true;
    const { sessionId, transport } = this;
    this.dispose();
    try {
      await transport.send("Target.detachFromTarget", { sessionId }, { timeoutMs: 2_000 });
    } catch {
      /* target or transport already gone */
    }
  }
}