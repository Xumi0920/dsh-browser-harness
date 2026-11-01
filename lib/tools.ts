/**
 * Tool definitions for the DSH plugin surface.
 *
 * `createTools(ctx, manager, config, defineTool)` is dependency injected so the
 * whole layer is unit-testable without the DSH host: the real entry passes
 * `defineTool` from @deepseek-ai/dsh-tools, tests pass an identity stub.
 */

import { HarnessError } from "../src/errors.js";
import { findByRole, formatSnapshot } from "../src/ax.js";

const textOutput = (value: any) => (typeof value === "string" ? value : JSON.stringify(value, null, 2));

const jsonOutput = {
  schema: { type: "object", additionalProperties: true },
  render: (_args: any, value: any) => [{ type: "text", text: textOutput(value) }],
};

// Query keys are normalized (lowercase, separators removed) before matching so
// accessToken / access-token / ACCESS_TOKEN / %61ccessToken all match. Keep this
// a finite canonical set: substring rules would also redact monkey/tokenizer.
const SENSITIVE_QUERY = /^(token|accesstoken|refreshtoken|idtoken|session|sessionid|sid|auth|authorization|password|passwd|secret|apikey|key|code)$/i;
// Location / Content-Location carry redirect URLs that may themselves contain
// credentials; conservatively redact the whole value (case-insensitive).
const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|location|content-location|x[-_].*(token|secret|session|auth|key).*)$/i;

/** Strip credentials and sensitive query values before a URL enters tool output. */
export function redactUrlForOutput(raw: any) {
  const text = String(raw || "");
  if (!text) return raw;
  try {
    const url = new URL(text);
    let changed = false;
    if (url.username) { url.username = "redacted"; changed = true; }
    if (url.password) { url.password = "redacted"; changed = true; }
    for (const [key, value] of [...url.searchParams.entries()]) {
      const normalizedKey = key.toLowerCase().replace(/[-_\s]/g, "");
      if (SENSITIVE_QUERY.test(normalizedKey) || /(token|secret|session|password|authorization)/i.test(value)) {
        url.searchParams.set(key, "[redacted]");
        changed = true;
      }
    }
    if (url.hash) { url.hash = "#redacted"; changed = true; }
    return changed ? url.toString() : text;
  } catch {
    return text;
  }
}

/** Redact credential-carrying response/request headers. */
export function redactHeadersForOutput(headers: any) {
  if (!headers || typeof headers !== "object") return headers;
  const out: any = {};
  for (const [key, value] of Object.entries(headers)) out[key] = SENSITIVE_HEADER.test(key) ? "[redacted]" : value;
  return out;
}

function redactEvent(event: any) {
  return {
    ...event,
    ...(event && event.url !== undefined ? { url: redactUrlForOutput(event.url) } : {}),
    ...(event && event.headers !== undefined ? { headers: redactHeadersForOutput(event.headers) } : {}),
  };
}

function redactStatus(status: any) {
  if (!status || typeof status !== "object") return status;
  return {
    ...status,
    ...(status.current ? { current: redactEvent(status.current) } : {}),
    ...(Array.isArray(status.tabs) ? { tabs: status.tabs.map(redactEvent) } : {}),
  };
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
      if (error instanceof HarnessError) throw new Error(error.code + ": " + error.message);
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
  const tool = (definition: any) => defineTool(definition);
  const maxSnapshotNodes = Number(config.maxSnapshotNodes) || 250;

  return [
    tool({
      name: "browser_status",
      description:
        "Check the browser harness: CDP endpoint, browser version, open tabs and the current tab. Use this first when a browser task starts or when another browser_* tool fails to connect.",
      parameters: {},
      output: jsonOutput,
      timeoutMs: 20_000,
      isConcurrencySafe: () => true,
      execute: wrap(async (args: any, sessionId: any) => redactStatus(await manager.status(sessionId))),
    }),

    tool({
      name: "browser_navigate",
      description:
        "Open a URL in the dedicated Chromium-based automation browser (Chrome, Edge, Brave, Chromium, ...) and return the page info plus a compact accessibility snapshot with clickable refs (e1, e2, ...). Reuses the session's current tab; pass newTab=true to keep the previous page.",
      parameters: {
        url: { type: "string", required: true, description: "http(s) URL to open" },
        newTab: { type: "boolean", description: "open in a new background tab instead of the current one" },
        waitUntil: { type: "string", enum: ["load", "domcontentloaded", "none"], description: "navigation wait strategy (default load)" },
      },
      output: jsonOutput,
      timeoutMs: 60_000,
      isConcurrencySafe: () => false,
      execute: wrap(async (args: any, sessionId: any) => {
        const page = await manager.navigate(sessionId, String(args.url), { newTab: Boolean(args.newTab), waitUntil: args.waitUntil });
        const info = await page.info();
        const snapshot = await page.snapshot({ maxNodes: maxSnapshotNodes });
        const rendered = formatSnapshot(snapshot);
        return { ...summarizePage(page, info), snapshot: rendered.text, nodes: snapshot.nodes.length, truncated: rendered.truncated };
      }),
    }),

    tool({
      name: "browser_snapshot",
      description:
        "Return the current page's compact accessibility snapshot: one line per actionable element with its ref (e1...), role, name and viewport center. Refs are snapshot-scoped; take a new snapshot after navigation or DOM changes.",
      parameters: {
        maxNodes: { type: "number", description: "maximum nodes to return (default 250, capped at 400)" },
        role: { type: "string", description: "only include this ARIA role (e.g. button)" },
        name: { type: "string", description: "only include nodes whose name contains this text (case-insensitive)" },
      },
      output: jsonOutput,
      timeoutMs: 30_000,
      isConcurrencySafe: () => true,
      execute: wrap(async (args: any, sessionId: any) => {
        const page = await manager.pageFor(sessionId);
        const snapshot = await page.snapshot({ maxNodes: Math.min(Number(args.maxNodes) || maxSnapshotNodes, 400) });
        let nodes = snapshot.nodes;
        if (args.role || args.name) nodes = findByRole(nodes, { role: args.role, name: args.name });
        const rendered = formatSnapshot({ ...snapshot, nodes });
        return { targetId: page.targetId, url: redactUrlForOutput((await page.info()).url), text: rendered.text, nodes: nodes.length, truncated: rendered.truncated };
      }),
    }),

    tool({
      name: "browser_act",
      description:
        "Perform one browser action: click a ref/selector/coordinate, type into the focused element, fill an input like a user, press a key, or scroll. Use refs from browser_navigate/browser_snapshot; verify the result afterwards (snapshot or browser_extract). fill returns only length/verified, never the entered value.",
      parameters: {
        action: { type: "string", required: true, enum: ["click", "type", "fill", "press", "scroll"], description: "action to perform" },
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
      },
      output: jsonOutput,
      timeoutMs: 30_000,
      isConcurrencySafe: () => false,
      execute: wrap(async (args: any, sessionId: any) => {
        const page = await manager.pageFor(sessionId);
        const action = String(args.action);
        if (action === "click") {
          const target = args.ref || args.selector ? { ref: args.ref, selector: args.selector } : args.x !== undefined && args.y !== undefined ? { at: { x: args.x, y: args.y } } : null;
          if (!target) throw new HarnessError("E_BAD_ARG", "click needs ref, selector, or x+y");
          return { action, ...(await page.click(target, { button: args.button, clicks: Number(args.clicks) || 1 })) };
        }
        if (action === "type") return { action, ...(await page.type(String(args.text ?? ""))) };
        if (action === "fill") {
          if (!args.ref && !args.selector) throw new HarnessError("E_BAD_ARG", "fill needs ref or selector");
          return { action, ...(await page.fill({ ref: args.ref, selector: args.selector, text: String(args.text ?? "") }, { verify: true })) };
        }
        if (action === "press") {
          const modifiers = String(args.modifiers || "").split(",").map((part: any) => part.trim()).filter(Boolean);
          return { action, ...(await page.press(String(args.key || "Enter"), { modifiers })) };
        }
        if (action === "scroll") return { action, ...(await page.scroll({ dx: Number(args.dx) || 0, dy: Number(args.dy) || 0 })) };
        throw new HarnessError("E_BAD_ARG", "unknown action: " + action);
      }),
    }),

    tool({
      name: "browser_extract",
      description:
        "Read from the current page: visible text (text), raw HTML (html), a JavaScript expression result (js), or captured network responses (network). Prefer browser_snapshot for interaction targets and this tool for content/data. js mode executes arbitrary page JavaScript with user-gesture semantics: it can change page state and is treated as non-concurrent; URLs/headers with token-like values are redacted in output, page content itself is not.",
      parameters: {
        mode: { type: "string", required: true, enum: ["text", "html", "js", "network"], description: "what to read" },
        selector: { type: "string", description: "CSS selector for text/html modes (defaults to body)" },
        expression: { type: "string", description: "JavaScript expression for js mode; string/serialized results are capped at 200k chars with truncated:true" },
        includeBody: { type: "boolean", description: "network mode: include response bodies (slower)" },
        urlContains: { type: "string", description: "network mode: only responses whose URL contains this" },
      },
      output: jsonOutput,
      timeoutMs: 30_000,
      isConcurrencySafe: () => false,
      execute: wrap(async (args: any, sessionId: any) => {
        const page = await manager.pageFor(sessionId);
        const mode = String(args.mode);
        if (mode === "text") {
          const value = await page.text(args.selector);
          const text = typeof value === "string" ? value : "";
          const truncated = text.length > 200_000;
          return { mode, value: truncated ? text.slice(0, 200_000) : value, truncated };
        }
        if (mode === "html") {
          const value = await page.evaluate((selector: any) => {
            const element = selector ? document.querySelector(selector) : document.documentElement;
            return element ? element.outerHTML : null;
          }, { args: [args.selector || null] });
          return { mode, value: typeof value === "string" && value.length > 200_000 ? value.slice(0, 200_000) : value, truncated: typeof value === "string" && value.length > 200_000 };
        }
        if (mode === "js") {
          if (!args.expression) throw new HarnessError("E_BAD_ARG", "js mode needs expression");
          const value = await page.evaluate(String(args.expression));
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
      }),
    }),

    tool({
      name: "browser_screenshot",
      description: "Capture a PNG screenshot of the current page and return its file path (open it with an image reader). Use when layout or visual state matters. The file is written inside the configured screenshotDir (default <stateDir>/screenshots); existing files are never overwritten.",
      parameters: {
        fullPage: { type: "boolean", description: "capture beyond the viewport (default false)" },
        path: { type: "string", description: "optional relative file name under screenshotDir (default: bh-shot-<timestamp>.png)" },
      },
      output: jsonOutput,
      timeoutMs: 60_000,
      isConcurrencySafe: () => false,
      execute: wrap(async (args: any, sessionId: any) => {
        const page = await manager.pageFor(sessionId);
        return page.screenshot({ fullPage: Boolean(args.fullPage), path: args.path });
      }),
    }),

    tool({
      name: "browser_tabs",
      description:
        "Manage background tabs: list them, switch the session to one (use), open a new blank tab, or close a tab this harness created. Never closes user tabs.",
      parameters: {
        action: { type: "string", required: true, enum: ["list", "use", "new", "close"], description: "tab operation" },
        targetId: { type: "string", description: "exact target id for use/close; use also accepts a URL substring of a harness-owned tab" },
        url: { type: "string", description: "optional URL for new" },
      },
      output: jsonOutput,
      timeoutMs: 30_000,
      isConcurrencySafe: () => false,
      execute: wrap(async (args: any, sessionId: any) => {
        const action = String(args.action);
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
          const page = await manager.useTab(sessionId, args.targetId);
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
