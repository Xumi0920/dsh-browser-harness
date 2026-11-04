/**
 * Tool definitions for the DSH plugin surface.
 *
 * `createTools(ctx, manager, config, defineTool)` is dependency injected so the
 * whole layer is unit-testable without the DSH host: the real entry passes
 * `defineTool` from @deepseek-ai/dsh-tools, tests pass an identity stub.
 */

import { mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { HarnessError } from "../src/errors.js";
import { findByRole, formatSnapshot } from "../src/ax.js";
import { redactHeadersForOutput, redactTextForOutput, redactUrlForOutput } from "../src/redact.js";
import { collectAutoDiagnosis } from "./diagnosis.js";

export { redactHeadersForOutput, redactTextForOutput, redactUrlForOutput };

const textOutput = (value: any) => (typeof value === "string" ? value : JSON.stringify(value, null, 2));

const jsonOutput = {
  schema: { type: "object", additionalProperties: true },
  render: (_args: any, value: any) => [{ type: "text", text: textOutput(value) }],
};

function redactEvent(event: any) {
  return {
    ...event,
    ...(event && event.url !== undefined ? { url: redactUrlForOutput(event.url) } : {}),
    ...(event && event.headers !== undefined ? { headers: redactHeadersForOutput(event.headers) } : {}),
  };
}

function redactEndpoint(endpoint: any) {
  if (!endpoint || typeof endpoint !== "object") return endpoint;
  return {
    id: endpoint.id,
    label: endpoint.label,
    port: endpoint.port,
    enabled: endpoint.enabled,
    status: endpoint.status,
    browser: endpoint.browser ?? null,
    ...(endpoint.error ? { error: redactTextForOutput(endpoint.error) } : {}),
  };
}

function redactStatus(status: any) {
  if (!status || typeof status !== "object") return status;
  const out: any = {
    connected: Boolean(status.connected),
    version: status.version ?? null,
    tabs: Array.isArray(status.tabs) ? status.tabs.map(redactEvent) : [],
    current: status.current ? redactEvent(status.current) : null,
    endpoints: Array.isArray(status.endpoints) ? status.endpoints.map(redactEndpoint) : [],
  };
  if (status.tabGroups !== undefined) out.tabGroups = status.tabGroups;
  if (status.error !== undefined) out.error = redactTextForOutput(status.error);
  return out;
}





async function performAct(page: any, args: any) {
  const action = String(args.action);
  if (action === "click") {
    const target = args.ref || args.selector ? { ref: args.ref, selector: args.selector } : args.x !== undefined && args.y !== undefined ? { at: { x: args.x, y: args.y } } : null;
    if (!target) throw new HarnessError("E_BAD_ARG", "click needs ref, selector, or x+y");
    return { action, ...(await page.click(target, { button: args.button, clicks: Number(args.clicks) || 1, force: args.force === true })) };
  }
  if (action === "hover") {
    if (!args.ref && !args.selector) throw new HarnessError("E_BAD_ARG", "hover needs ref or selector");
    return { action, ...(await page.hover({ ref: args.ref, selector: args.selector })) };
  }
  if (action === "highlight") {
    if (!args.ref && !args.selector) throw new HarnessError("E_BAD_ARG", "highlight needs ref or selector");
    return { action, ...(await page.highlight({ ref: args.ref, selector: args.selector })) };
  }
  if (action === "drag") {
    const source = args.ref || args.selector ? { ref: args.ref, selector: args.selector } : null;
    const target = args.toRef || args.toSelector ? { ref: args.toRef, selector: args.toSelector } : null;
    if (!source) throw new HarnessError("E_BAD_ARG", "drag needs source ref or selector");
    if (!target) throw new HarnessError("E_BAD_ARG", "drag needs toRef or toSelector");
    return { action, ...(await page.drag(source, target, { steps: args.steps })) };
  }
  if (action === "type") {
    if (args.ref || args.selector) await page.focus({ ref: args.ref, selector: args.selector });
    return { action, ...(await page.type(String(args.text ?? ""))) };
  }
  if (action === "dialog") {
    if (!page.dialog()) throw new HarnessError("E_NO_DIALOG", "no JavaScript dialog is open");
    return { action, ...(await page.handleDialog({ accept: args.accept !== false, promptText: args.promptText })) };
  }
  if (action === "fill") {
    if (!args.ref && !args.selector) throw new HarnessError("E_BAD_ARG", "fill needs ref or selector");
    return { action, ...(await page.fill({ ref: args.ref, selector: args.selector, text: String(args.text ?? "") }, { verify: true })) };
  }
  if (action === "selectOption") {
    if (!args.ref && !args.selector) throw new HarnessError("E_BAD_ARG", "selectOption needs ref or selector");
    if (!Array.isArray(args.values) || args.values.length === 0) throw new HarnessError("E_BAD_ARG", "selectOption needs values");
    return { action, ...(await page.selectOption({ ref: args.ref, selector: args.selector }, args.values)) };
  }
  if (action === "check" || action === "uncheck") {
    if (!args.ref && !args.selector) throw new HarnessError("E_BAD_ARG", action + " needs ref or selector");
    return { action, ...(await page.setChecked({ ref: args.ref, selector: args.selector }, action === "check")) };
  }
  if (action === "press") {
    const modifiers = String(args.modifiers || "").split(",").map((part: any) => part.trim()).filter(Boolean);
    return { action, ...(await page.press(String(args.key || "Enter"), { modifiers })) };
  }
  if (action === "scroll") return { action, ...(await page.scroll({ dx: Number(args.dx) || 0, dy: Number(args.dy) || 0 })) };
  throw new HarnessError("E_BAD_ARG", "unknown action: " + action);
}

async function applyActExpectations(page: any, args: any, result: any) {
  const expectUrl = args.expectUrl === undefined ? null : String(args.expectUrl);
  const expectText = args.expectText === undefined ? null : String(args.expectText);
  const expectSelector = args.expectSelector === undefined ? null : String(args.expectSelector);
  if (!expectUrl && !expectText && !expectSelector) return result;
  const timeoutMs = Math.min(Math.max(Number(args.expectTimeoutMs) || 5_000, 100), 30_000);
  const started = Date.now();
  try {
    await Promise.all([
      expectUrl ? page.waitForFunction("location.href.includes(" + JSON.stringify(expectUrl) + ")", { timeoutMs }) : null,
      expectText ? page.waitForFunction("(() => { const body = document.body ? document.body.innerText : ''; return body.includes(" + JSON.stringify(expectText) + "); })()", { timeoutMs }) : null,
      expectSelector ? page.waitForSelector(expectSelector, { timeoutMs, visible: true }) : null,
    ]);
  } catch (error: any) {
    throw new HarnessError("E_EXPECTATION_FAILED", "action completed but result expectations were not met", {
      cause: error,
      details: { expectUrl, expectText, expectSelector, timeoutMs },
    });
  }
  const info = await page.info().catch(() => null);
  return {
    ...result,
    expectation: {
      ok: true,
      elapsedMs: Date.now() - started,
      url: info ? redactUrlForOutput(info.url) : null,
      expectUrl,
      expectText,
      expectSelector,
    },
  };
}

function withPage(manager: any, sessionId: any, fn: any) {
  if (typeof manager.withPage === "function") return manager.withPage(sessionId, fn);
  return manager.pageFor(sessionId).then((page: any) => fn(page));
}

function withNavigatedPage(manager: any, sessionId: any, url: any, options: any, fn: any) {
  if (typeof manager.withNavigatedPage === "function") return manager.withNavigatedPage(sessionId, url, options, fn);
  return manager.navigate(sessionId, url, options).then((page: any) => fn(page));
}

async function browserConfig(page: any, manager: any) {
  if (page && page.browser && page.browser.config) return page.browser.config;
  const browser = await manager.ensure();
  return (browser && browser.config) || {};
}

async function validateUploadFiles(page: any, manager: any, requested: any) {
  const config = await browserConfig(page, manager);
  const directory = config.uploadDir || (config.stateDir ? join(config.stateDir, "uploads") : null);
  if (!directory) throw new HarnessError("E_BAD_ARG", "uploadDir is not configured");
  const base = resolve(directory);
  await mkdir(base, { recursive: true, mode: 0o700 });
  const realBase = await realpath(base).catch(() => {
    throw new HarnessError("E_POLICY_DENIED", "cannot resolve uploadDir", { uploadDir: base });
  });
  const entries = (Array.isArray(requested) ? requested : [requested]).map((value: any) => String(value)).filter(Boolean);
  if (!entries.length) throw new HarnessError("E_BAD_ARG", "upload needs path or paths");
  const files = [];
  for (const entry of entries) {
    const target = resolve(base, entry);
    const lexical = relative(resolve(directory), target);
    if (lexical === ".." || lexical.startsWith(".." + sep) || isAbsolute(lexical)) {
      throw new HarnessError("E_POLICY_DENIED", "upload path must stay inside uploadDir", { path: target, uploadDir: base });
    }
    const real = await realpath(target).catch(() => {
      throw new HarnessError("E_BAD_ARG", "upload file does not exist", { path: target });
    });
    const inside = relative(realBase, real);
    if (inside === ".." || inside.startsWith(".." + sep) || isAbsolute(inside)) {
      throw new HarnessError("E_POLICY_DENIED", "upload path escapes uploadDir through a link", { path: target });
    }
    const info = await stat(real).catch(() => null);
    if (!info || !info.isFile()) throw new HarnessError("E_BAD_ARG", "upload path is not a regular file", { path: target });
    files.push(real);
  }
  return files;
}

function summarizePage(page: any, info: any) {
  return {
    targetId: page.targetId,
    url: redactUrlForOutput(info && info.url),
    title: info && info.title,
    readyState: info && info.readyState,
    viewport: info && info.viewport,
  };
}

function wrap(handler: any) {
  return async (args: any, exec: any) => {
    const sessionId = exec && exec.agent && exec.agent.session ? exec.agent.session.id : undefined;
    try {
      return await handler(args, sessionId, exec);
    } catch (error: any) {
      if (error instanceof HarnessError) throw new Error(error.code + ": " + redactTextForOutput(error.message));
      throw error;
    }
  };
}

/**
 * Build the browser_* tool definitions.
 * @param {any} ctx cordis context (unused directly; tools register via manager)
 * @param {import("./manager.js").BrowserManager} manager
 * @param {Record<string, any>} config
 * @param {(definition: any) => any} defineTool
 * @returns {any[]}
 */
export function createTools(ctx: any, manager: any, config: any = {} as any, defineTool: any) {
  const autoDiagnose = config.autoDiagnose === "errors";
  const diagnosisTools = new Set([
    "browser_navigate", "browser_wait", "browser_snapshot", "browser_act", "browser_extract",
    "browser_screenshot", "browser_pdf", "browser_upload", "browser_download",
  ]);
  const tool = (definition: any) => {
    const execute = definition.execute;
    definition.execute = async (args: any, exec: any) => {
      try {
        return await execute(args, exec);
      } catch (error: any) {
        if (!autoDiagnose || !diagnosisTools.has(definition.name)) throw error;
        const sessionId = exec && exec.agent && exec.agent.session ? exec.agent.session.id : undefined;
        const diagnosis = await collectAutoDiagnosis(manager, sessionId, definition.name, error);
        if (!diagnosis) throw error;
        const summary = "tool=" + diagnosis.tool + ", code=" + diagnosis.code + ", screenshot=" + (diagnosis.screenshot ? "yes" : "no");
        const wrapped = new Error(String(error && error.message ? error.message : error) + "\nDiagnosis: " + diagnosis.path + "\nDiagnosis summary: " + summary);
        (wrapped as any).code = error && error.code;
        (wrapped as any).diagnosis = diagnosis;
        throw wrapped;
      }
    };
    return defineTool(definition);
  };
  const maxSnapshotNodes = Number(config.maxSnapshotNodes) || 250;
  const readOnly = config.readOnly === true;
  const assertWritable = (what: string) => {
    if (readOnly) throw new HarnessError("E_READ_ONLY", "read-only mode blocks " + what);
  };

  return [
    tool({
      name: "browser_status",
      description:
        "Check the browser harness: CDP endpoint, browser version, open tabs and the current tab. Use this first when a browser task starts or when another browser_* tool fails to connect.",
      parameters: {},
      output: jsonOutput,
      timeoutMs: 20_000,
      isConcurrencySafe: () => true,
      execute: wrap(async (args: any, sessionId: any) => {
        const status = await manager.status(sessionId);
        let task = null;
        try { task = await manager.taskStatus(sessionId); } catch { task = null; }
        return redactStatus({ ...status, task });
      }),
    }),



    tool({
      name: "browser_wait",
      description:
        "Wait for the page to reach a state before the next action: a selector/text/URL appears or disappears, a response completes, network activity becomes idle, or a fixed delay. Prefer this over repeatedly calling browser_snapshot.",
      parameters: {
        mode: { type: "string", required: true, enum: ["selector", "selector_hidden", "text", "text_gone", "text_changed", "url", "url_changed", "response", "network_idle", "delay"], description: "what to wait for" },
        selector: { type: "string", description: "selector/selector_hidden mode: CSS selector" },
        text: { type: "string", description: "text/text_gone mode: visible page text" },
        url: { type: "string", description: "url/url_changed/response mode: URL substring" },
        visible: { type: "boolean", description: "selector mode: require the element to be visible too" },
        includeBody: { type: "boolean", description: "response mode: include the response body" },
        timeoutMs: { type: "number", description: "maximum wait in milliseconds (default 30000, capped at 120000)" },
        delayMs: { type: "number", description: "delay mode: milliseconds to wait (default 1000)" },
        idleMs: { type: "number", description: "network_idle mode: quiet window in milliseconds (default 500)" },
      },
      output: jsonOutput,
      timeoutMs: 120_000,
      isConcurrencySafe: () => false,
      execute: wrap(async (args: any, sessionId: any) => {
        const mode = String(args.mode);
        const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 30_000, 100), 120_000);
        if (mode === "delay") {
          const delayMs = Math.min(Math.max(Number(args.delayMs) || 1_000, 0), timeoutMs);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return { mode, waitedMs: delayMs };
        }
        return withPage(manager, sessionId, async (page: any) => {
        if (mode === "selector") {
          if (!args.selector) throw new HarnessError("E_BAD_ARG", "selector mode needs selector");
          const found = await page.waitForSelector(String(args.selector), { timeoutMs, visible: Boolean(args.visible) });
          return { mode, matched: true, selector: args.selector, found };
        }
        if (mode === "selector_hidden") {
          if (!args.selector) throw new HarnessError("E_BAD_ARG", "selector_hidden mode needs selector");
          const selector = JSON.stringify(String(args.selector));
          const expression = "(() => { const el = document.querySelector(" + selector + "); if (!el) return true; if (typeof el.checkVisibility === 'function') return !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }); return getComputedStyle(el).display === 'none' || getComputedStyle(el).visibility === 'hidden'; })()";
          await page.waitForFunction(expression, { timeoutMs });
          return { mode, hidden: true, selector: args.selector };
        }
        if (mode === "text") {
          if (!args.text) throw new HarnessError("E_BAD_ARG", "text mode needs text");
          const expression = "(() => { const body = document.body ? document.body.innerText : ''; return body.includes(" + JSON.stringify(String(args.text)) + "); })()";
          await page.waitForFunction(expression, { timeoutMs });
          return { mode, matched: true, text: args.text };
        }
        if (mode === "text_gone") {
          if (!args.text) throw new HarnessError("E_BAD_ARG", "text_gone mode needs text");
          const expression = "(() => { const body = document.body ? document.body.innerText : ''; return !body.includes(" + JSON.stringify(String(args.text)) + "); })()";
          await page.waitForFunction(expression, { timeoutMs });
          return { mode, gone: true, text: args.text };
        }
        if (mode === "text_changed") {
          if (!args.text) throw new HarnessError("E_BAD_ARG", "text_changed mode needs current text");
          const before = String(args.text);
          const expression = "(() => { const body = document.body ? document.body.innerText : ''; return body !== " + JSON.stringify(before) + "; })()";
          await page.waitForFunction(expression, { timeoutMs });
          return { mode, changed: true };
        }
        if (mode === "url") {
          if (!args.url) throw new HarnessError("E_BAD_ARG", "url mode needs url");
          const expression = "location.href.includes(" + JSON.stringify(String(args.url)) + ")";
          await page.waitForFunction(expression, { timeoutMs });
          return { mode, matched: true, url: args.url };
        }
        if (mode === "url_changed") {
          if (!args.url) throw new HarnessError("E_BAD_ARG", "url_changed mode needs current url");
          const before = String(args.url);
          const expression = "location.href !== " + JSON.stringify(before);
          await page.waitForFunction(expression, { timeoutMs });
          return { mode, changed: true, url: await page.evaluate("location.href") };
        }
        if (mode === "response") {
          if (!args.url) throw new HarnessError("E_BAD_ARG", "response mode needs url");
          const response = await page.waitForResponse(String(args.url), { timeoutMs, includeBody: Boolean(args.includeBody) });
          return { mode, matched: true, response };
        }
        if (mode === "network_idle") {
          const result = await page.waitForNetworkIdle({ timeoutMs, idleMs: Number(args.idleMs) || 500 });
          return { mode, ...result };
        }
        throw new HarnessError("E_BAD_ARG", "unknown wait mode: " + mode);
        });
      }),
    }),

    tool({
      name: "browser_navigate",
      description:
        "Open a URL in the dedicated Chromium-based automation browser (Chrome, Edge, Brave, Chromium, ...) and return the page info plus a compact accessibility snapshot with clickable refs (e1, e2, ...). Reuses the session's current tab; pass newTab=true to keep the previous page. Use action back/forward/reload for browser history instead of a URL.",
      parameters: {
        action: { type: "string", enum: ["open", "back", "forward", "reload"], description: "navigation action (default open)" },
        url: { type: "string", description: "http(s) URL to open (required when action is open)" },
        newTab: { type: "boolean", description: "open in a new background tab instead of the current one" },
        waitUntil: { type: "string", enum: ["load", "domcontentloaded", "none"], description: "navigation wait strategy (default load)" },
      },
      output: jsonOutput,
      timeoutMs: 60_000,
      isConcurrencySafe: () => false,
      execute: wrap(async (args: any, sessionId: any) => {
        const action = String(args.action || "open");
        const buildResult = async (page: any) => {
          const info = await page.info();
          const snapshot = await page.snapshot({ maxNodes: maxSnapshotNodes });
          const rendered = formatSnapshot(snapshot);
          return { action, ...summarizePage(page, info), snapshot: rendered.text, nodes: snapshot.nodes.length, truncated: rendered.truncated };
        };
        if (action === "open") {
          if (!args.url) throw new HarnessError("E_BAD_ARG", "open needs url");
          return withNavigatedPage(manager, sessionId, String(args.url), { newTab: Boolean(args.newTab), waitUntil: args.waitUntil }, buildResult);
        }
        if (action !== "back" && action !== "forward" && action !== "reload") throw new HarnessError("E_BAD_ARG", "unknown navigation action: " + action);
        return withPage(manager, sessionId, async (page: any) => {
          await page.history(action, { waitUntil: args.waitUntil });
          return buildResult(page);
        });
      }),
    }),

    tool({
      name: "browser_snapshot",
      description:
        "Return the current page's compact accessibility snapshot: one line per actionable element with its ref (e1...), role, name and viewport center. Pass frameId (from browser_extract mode:'frames') to snapshot an iframe. Refs are snapshot-scoped; take a new snapshot after navigation or DOM changes.",
      parameters: {
        maxNodes: { type: "number", description: "maximum nodes to return (default 250, capped at 400)" },
        role: { type: "string", description: "only include this ARIA role (e.g. button)" },
        name: { type: "string", description: "only include nodes whose name contains this text (case-insensitive)" },
        frameId: { type: "string", description: "optional iframe frameId from browser_extract mode:'frames'" },
        offset: { type: "number", description: "optional zero-based node offset for pagination" },
        limit: { type: "number", description: "optional page size after filtering" },
      },
      output: jsonOutput,
      timeoutMs: 30_000,
      isConcurrencySafe: () => false,
      execute: wrap(async (args: any, sessionId: any) => {
        return withPage(manager, sessionId, async (page: any) => {
        const offset = Math.max(0, Number(args.offset) || 0);
        const limit = Math.min(Math.max(Number(args.limit) || Number(args.maxNodes) || maxSnapshotNodes, 1), 400);
        const snapshot = await page.snapshot({ maxNodes: limit, offset, frameId: args.frameId, role: args.role, name: args.name });
        let nodes = snapshot.nodes;
        if (args.role || args.name) nodes = findByRole(nodes, { role: args.role, name: args.name });
        const total = Number.isFinite(snapshot.total) ? snapshot.total : nodes.length;
        // Compatibility for the old in-memory fake pages that ignore offset.
        if (offset > 0 && nodes.length > limit) nodes = nodes.slice(offset, offset + limit);
        const truncated = Boolean(snapshot.truncated) || offset + nodes.length < total;
        const rendered = formatSnapshot({ ...snapshot, nodes, truncated });
        const snapshotVersion = snapshot.snapshotVersion;
        return {
          targetId: page.targetId,
          snapshotId: page.targetId + ":" + snapshotVersion,
          snapshotVersion,
          url: redactUrlForOutput((await page.info()).url),
          text: rendered.text,
          nodes: nodes.length,
          total,
          offset,
          limit,
          truncated: rendered.truncated,
        };
        });
      }),
    }),

    tool({
      name: "browser_act",
      description:
        "Perform one browser action: click a ref/selector/coordinate, hover or highlight an element, drag from a ref/selector to another ref/selector, type into the focused element (or focus a ref/selector first), fill an input like a user, select native options, check/uncheck a checkbox, press a key, scroll, or accept/dismiss the current JavaScript dialog. After the action, optional expectUrl/expectText/expectSelector assertions wait for the page to reach the expected state and fail with E_EXPECTATION_FAILED instead of returning a false success. fill returns only length/verified, never the entered value.",
      parameters: {
        action: { type: "string", required: true, enum: ["click", "hover", "highlight", "drag", "type", "fill", "selectOption", "check", "uncheck", "press", "scroll", "dialog"], description: "action to perform" },
        ref: { type: "string", description: "snapshot ref such as e3" },
        selector: { type: "string", description: "CSS selector (use instead of ref/coordinates)" },
        x: { type: "number", description: "viewport x for click" },
        y: { type: "number", description: "viewport y for click" },
        text: { type: "string", description: "text for type/fill" },
        key: { type: "string", description: "key name for press (Enter, Tab, Escape, ArrowDown, a, ...)" },
        modifiers: { type: "string", description: "press modifiers: Alt,Control,Meta,Shift (comma separated)" },
        dx: { type: "number", description: "scroll delta x" },
        dy: { type: "number", description: "scroll delta y" },
        button: { type: "string", enum: ["left", "right", "middle"], description: "mouse button for click" },
        clicks: { type: "number", description: "click count (default 1)" },
        values: { type: "array", items: { type: "string" }, description: "selectOption: option values or labels" },
        force: { type: "boolean", description: "click despite an overlay hit-test failure; prefer fixing the overlay" },
        accept: { type: "boolean", description: "dialog: accept (true, default) or dismiss (false)" },
        promptText: { type: "string", description: "dialog: text for a prompt() dialog" },
        expectUrl: { type: "string", description: "after the action, wait until location.href contains this value" },
        expectText: { type: "string", description: "after the action, wait until page body text contains this value" },
        expectSelector: { type: "string", description: "after the action, wait until this selector exists and is visible" },
        toRef: { type: "string", description: "drag: target snapshot ref" },
        toSelector: { type: "string", description: "drag: target CSS selector" },
        steps: { type: "number", description: "drag: interpolation steps (default 10, capped at 100)" },
        expectTimeoutMs: { type: "number", description: "expectation wait in milliseconds (default 5000, capped at 30000)" },
      },
      output: jsonOutput,
      timeoutMs: 65_000,
      isConcurrencySafe: () => false,
      execute: wrap(async (args: any, sessionId: any) => {
        assertWritable("browser_act");
        return withPage(manager, sessionId, async (page: any) => {
        const result = await performAct(page, args);
        return applyActExpectations(page, args, result);
        });
      }),
    }),

    tool({
      name: "browser_extract",
      description:
        "Read from the current page: visible text (text), raw HTML (html), a JavaScript expression result (js), captured network responses (network), recent console/log events (console), or the iframe tree (frames). Prefer browser_snapshot for interaction targets and this tool for content/data. js mode executes arbitrary page JavaScript with user-gesture semantics: it can change page state and is treated as non-concurrent; URLs/headers with token-like values are redacted in output, page content itself is not.",
      parameters: {
        mode: { type: "string", required: true, enum: ["text", "html", "js", "network", "console", "frames"], description: "what to read" },
        selector: { type: "string", description: "CSS selector for text/html modes (defaults to body)" },
        expression: { type: "string", description: "JavaScript expression for js mode; string/serialized results are capped at 200k chars with truncated:true" },
        includeBody: { type: "boolean", description: "network mode: include response bodies (slower)" },
        urlContains: { type: "string", description: "network mode: only responses whose URL contains this" },
        frameId: { type: "string", description: "optional iframe frameId for text/html/js modes" },
        frameUrl: { type: "string", description: "optional iframe URL substring for text/html/js modes" },
      },
      output: jsonOutput,
      timeoutMs: 30_000,
      isConcurrencySafe: () => false,
      execute: wrap(async (args: any, sessionId: any) => {
        return withPage(manager, sessionId, async (page: any) => {
        const mode = String(args.mode);
        const frameMatch = args.frameId || args.frameUrl ? { frameId: args.frameId, urlContains: args.frameUrl } : null;
        if (mode === "frames") {
          const frames = await page.frames();
          return { mode, frames, count: frames.length };
        }
        if (mode === "text") {
          const value = frameMatch
            ? await page.evaluateInFrame(frameMatch, (selector: any) => selector ? (document.querySelector(selector) ? document.querySelector(selector).innerText : null) : (document.body ? document.body.innerText : ""), { args: [args.selector || null] })
            : await page.text(args.selector);
          const text = typeof value === "string" ? value : "";
          const truncated = text.length > 200_000;
          return { mode, value: truncated ? text.slice(0, 200_000) : value, truncated };
        }
        if (mode === "html") {
          const expression = (selector: any) => {
            const element = selector ? document.querySelector(selector) : document.documentElement;
            return element ? element.outerHTML : null;
          };
          const value = frameMatch
            ? await page.evaluateInFrame(frameMatch, expression, { args: [args.selector || null] })
            : await page.evaluate(expression, { args: [args.selector || null] });
          return { mode, value: typeof value === "string" && value.length > 200_000 ? value.slice(0, 200_000) : value, truncated: typeof value === "string" && value.length > 200_000 };
        }
        if (mode === "js") {
          assertWritable("browser_extract js mode");
          if (!args.expression) throw new HarnessError("E_BAD_ARG", "js mode needs expression");
          const value = frameMatch
            ? await page.evaluateInFrame(frameMatch, String(args.expression))
            : await page.evaluate(String(args.expression));
          if (typeof value === "string" && value.length > 200_000) {
            return { mode, value: value.slice(0, 200_000), truncated: true };
          }
          let serialized: any = null;
          try { serialized = JSON.stringify(value); } catch { serialized = null; }
          if (serialized && serialized.length > 200_000) {
            return { mode, value: serialized.slice(0, 200_000), truncated: true, format: "json" };
          }
          return { mode, value };
        }
        if (mode === "console") {
          const events = page.consoleEvents().map((event: any) => ({
            ...event,
            text: redactTextForOutput(event.text),
            ...(event.url ? { url: redactUrlForOutput(event.url) } : {}),
          }));
          return { mode, events, count: events.length };
        }
        if (mode === "network") {
          const matched = page.networkEvents().filter((event: any) => !args.urlContains || String(event.url || "").includes(String(args.urlContains)));
          const events = matched.slice(-100).map(redactEvent);
          const capturing = Boolean(page.networkEnabled);
          if (args.includeBody) {
            const withBodies = (await page.networkBodies(events)).map(redactEvent);
            return { mode, events: withBodies, count: withBodies.length, capturing };
          }
          return { mode, events, count: events.length, capturing };
        }
        throw new HarnessError("E_BAD_ARG", "unknown mode: " + mode);
        });
      }),
    }),

    tool({
      name: "browser_screenshot",
      description: "Capture a PNG screenshot of the current page (or a ref/selector element) and return its file path (open it with an image reader). Use when layout or visual state matters. The file is written inside the configured screenshotDir (default <stateDir>/screenshots); existing files are never overwritten.",
      parameters: {
        fullPage: { type: "boolean", description: "capture beyond the viewport (default false)" },
        ref: { type: "string", description: "optional snapshot ref for an element-level screenshot" },
        selector: { type: "string", description: "optional CSS selector for an element-level screenshot" },
        path: { type: "string", description: "optional relative file name under screenshotDir (default: bh-shot-<timestamp>.png)" },
      },
      output: jsonOutput,
      timeoutMs: 60_000,
      isConcurrencySafe: () => false,
      execute: wrap(async (args: any, sessionId: any) => {
        return withPage(manager, sessionId, async (page: any) => {
          const clip = args.ref || args.selector ? await page.boxFor({ ref: args.ref, selector: args.selector }) : null;
          return page.screenshot({ fullPage: Boolean(args.fullPage), path: args.path, clip });
        });
      }),
    }),

    tool({
      name: "browser_pdf",
      description: "Export the current page as PDF and return its file path. The file is written inside the configured screenshotDir; existing files are never overwritten.",
      parameters: {
        path: { type: "string", description: "optional relative file name under screenshotDir (default: bh-print-<timestamp>.pdf)" },
        printBackground: { type: "boolean", description: "include CSS backgrounds (default true)" },
      },
      output: jsonOutput,
      timeoutMs: 60_000,
      isConcurrencySafe: () => false,
      execute: wrap(async (args: any, sessionId: any) => {
        return withPage(manager, sessionId, async (page: any) => page.pdf({ path: args.path, printBackground: args.printBackground !== false }));
      }),
    }),


    tool({
      name: "browser_diagnose",
      description:
        "Collect a failure-diagnosis bundle from the current tab: URL/title/readiness, pending dialog, active network requests, recent console/log events, failed or 4xx/5xx responses, and an optional screenshot.",
      parameters: {
        screenshot: { type: "boolean", description: "capture a screenshot (default true)" },
        path: { type: "string", description: "optional relative screenshot path under screenshotDir" },
        consoleLimit: { type: "number", description: "recent console events to include (default 100, max 500)" },
      },
      output: jsonOutput,
      timeoutMs: 60_000,
      isConcurrencySafe: () => false,
      execute: wrap(async (args: any, sessionId: any) => {
        return withPage(manager, sessionId, async (page: any) => {
        let info = null;
        try { info = await page.info(); } catch { info = null; }
        let screenshot = null;
        if (args.screenshot !== false) {
          try {
            screenshot = await page.screenshot(args.path ? { path: args.path } : {});
          } catch (error: any) {
            screenshot = { error: String((error && error.message) || error) };
          }
        }
        const consoleLimit = Math.min(Math.max(Number(args.consoleLimit) || 100, 1), 500);
        const consoleEvents = page.consoleEvents(consoleLimit).map((event: any) => ({
          ...event,
          text: redactTextForOutput(event.text),
          ...(event.url ? { url: redactUrlForOutput(event.url) } : {}),
        }));
        const failures = page.networkEvents()
          .filter((event: any) => event.error || Number(event.status) >= 400)
          .slice(-20)
          .map(redactEvent);
        let task = null;
        try { task = await manager.taskStatus(sessionId); } catch { task = null; }
        return {
          url: info ? redactUrlForOutput(info.url) : null,
          title: info ? info.title : null,
          readyState: info ? info.readyState : null,
          dialog: page.dialog(),
          activeRequests: page.activeRequests.size,
          console: consoleEvents,
          networkFailures: failures,
          screenshot,
          task,
        };
        });
      }),
    }),

    tool({
      name: "browser_upload",
      description:
        "Set files on a file input (visible or hidden). Paths are confined to the configured uploadDir (default <stateDir>/uploads); symlinks and paths escaping that directory are rejected. Copy the desired files into uploadDir first.",
      parameters: {
        ref: { type: "string", description: "snapshot ref of the file input" },
        selector: { type: "string", description: "CSS selector of the file input" },
        path: { type: "string", description: "one relative path under uploadDir" },
        paths: { type: "array", items: { type: "string" }, description: "multiple relative paths under uploadDir" },
      },
      output: jsonOutput,
      timeoutMs: 30_000,
      isConcurrencySafe: () => false,
      execute: wrap(async (args: any, sessionId: any) => {
        assertWritable("browser_upload");
        if (!args.ref && !args.selector) throw new HarnessError("E_BAD_ARG", "upload needs ref or selector");
        return withPage(manager, sessionId, async (page: any) => {
          const files = await validateUploadFiles(page, manager, args.paths || args.path);
          return { ...(await page.upload({ ref: args.ref, selector: args.selector }, files)), count: files.length };
        });
      }),
    }),

    tool({
      name: "browser_download",
      description:
        "Click a link/button and wait for its download to finish. Files land in the configured downloadDir (default <stateDir>/downloads) and the returned path/bytes can be processed by the caller.",
      parameters: {
        ref: { type: "string", description: "snapshot ref to click" },
        selector: { type: "string", description: "CSS selector to click" },
        timeoutMs: { type: "number", description: "maximum download wait (default 30000)" },
      },
      output: jsonOutput,
      timeoutMs: 120_000,
      isConcurrencySafe: () => false,
      execute: wrap(async (args: any, sessionId: any) => {
        assertWritable("browser_download");
        if (!args.ref && !args.selector) throw new HarnessError("E_BAD_ARG", "download needs ref or selector");
        return withPage(manager, sessionId, async (page: any) => {
          const config = await browserConfig(page, manager);
          const directory = config.downloadDir || (config.stateDir ? join(config.stateDir, "downloads") : null);
          if (!directory) throw new HarnessError("E_BAD_ARG", "downloadDir is not configured");
          const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 30_000, 100), 120_000);
          return page.download({ dir: directory, timeoutMs, trigger: () => page.click({ ref: args.ref, selector: args.selector }) });
        });
      }),
    }),


    tool({
      name: "browser_task",
      description:
        "Inspect or control this session's task lifecycle. status returns task state, owned tabs and locks; pause stops new page operations and releases leases; resume re-enables; close optionally closes owned tabs and marks the task closed; start creates a fresh task after close.",
      parameters: {
        action: { type: "string", required: true, enum: ["status", "pause", "resume", "close", "start"], description: "task operation" },
        cleanup: { type: "string", enum: ["close-owned", "leave"], description: "close: close owned tabs (default) or leave them open" },
      },
      output: jsonOutput,
      timeoutMs: 60_000,
      isConcurrencySafe: () => false,
      execute: wrap(async (args: any, sessionId: any) => {
        const action = String(args.action);
        if (action !== "status") assertWritable("browser_task " + action);
        if (action === "status") return manager.taskStatus(sessionId);
        if (action === "pause") return manager.pauseTask(sessionId);
        if (action === "resume") return manager.resumeTask(sessionId);
        if (action === "close") return manager.closeTask(sessionId, { cleanup: args.cleanup });
        if (action === "start") return manager.startTask(sessionId);
        throw new HarnessError("E_BAD_ARG", "unknown task action: " + action);
      }),
    }),

    tool({
      name: "browser_tabs",
      description:
        "Manage background tabs: list them, switch the session to one (use), open a new blank tab, or close a tab this harness created. Never closes user tabs.",
      parameters: {
        action: { type: "string", required: true, enum: ["list", "use", "new", "close"], description: "tab operation" },
        targetId: { type: "string", description: "exact target id for use/close; use also accepts a URL substring of a harness-owned tab" },
        borrow: { type: "boolean", description: "use: explicitly borrow a non-owned user tab after confirming with the user" },
        url: { type: "string", description: "optional URL for new" },
      },
      output: jsonOutput,
      timeoutMs: 30_000,
      isConcurrencySafe: () => false,
      execute: wrap(async (args: any, sessionId: any) => {
        const action = String(args.action);
        if (action === "new" || action === "close") assertWritable("browser_tabs " + action);
        if (action === "list") {
          const result = await manager.listTabs(sessionId);
          return {
            ...result,
            ...(Array.isArray(result && result.tabs) ? { tabs: result.tabs.map(redactEvent) } : {}),
            ...(result && result.current ? { current: redactEvent(result.current) } : {}),
          };
        }
        if (action === "use") {
          if (!args.targetId) throw new HarnessError("E_BAD_ARG", "use needs targetId");
          const page = await manager.useTab(sessionId, args.targetId, { borrow: args.borrow === true });
          return { used: page.targetId, ...(await summarizePage(page, await page.info())) };
        }
        if (action === "new") {
          const page = await manager.openTab(sessionId, args.url || "about:blank");
          return { created: page.targetId, ...(await summarizePage(page, await page.info())) };
        }
        if (action === "close") return manager.closeTab(sessionId, args.targetId);
        throw new HarnessError("E_BAD_ARG", "unknown action: " + action);
      }),
    }),
  ];
}
