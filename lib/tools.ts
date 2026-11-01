/**
 * Tool definitions for the DSH plugin surface.
 *
 * `createTools(ctx, manager, config, defineTool)` is dependency injected so the
 * whole layer is unit-testable without the DSH host: the real entry passes
 * `defineTool` from @deepseek-ai/dsh-tools, tests pass an identity stub.
 */

import { HarnessError } from "../src/errors.js";
import { findByRole, formatSnapshot } from "../src/ax.js";

const textOutput = (value) => (typeof value === "string" ? value : JSON.stringify(value, null, 2));

const jsonOutput = {
  schema: { type: "object", additionalProperties: true },
  render: (_args, value) => [{ type: "text", text: textOutput(value) }],
};

function summarizePage(page, info) {
  return {
    targetId: page.targetId,
    url: info && info.url,
    title: info && info.title,
    readyState: info && info.readyState,
    viewport: info && info.viewport,
  };
}

function wrap(handler) {
  return async (args, exec) => {
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
export function createTools(ctx, manager, config = {} as any, defineTool) {
  const tool = (definition) => defineTool(definition);
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
      execute: wrap(async (args, sessionId) => manager.status(sessionId)),
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
      execute: wrap(async (args, sessionId) => {
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
      execute: wrap(async (args, sessionId) => {
        const page = await manager.pageFor(sessionId);
        const snapshot = await page.snapshot({ maxNodes: Math.min(Number(args.maxNodes) || maxSnapshotNodes, 400) });
        let nodes = snapshot.nodes;
        if (args.role || args.name) nodes = findByRole(nodes, { role: args.role, name: args.name });
        const rendered = formatSnapshot({ ...snapshot, nodes });
        return { targetId: page.targetId, url: (await page.info()).url, text: rendered.text, nodes: nodes.length, truncated: rendered.truncated };
      }),
    }),

    tool({
      name: "browser_act",
      description:
        "Perform one browser action: click a ref/selector/coordinate, type into the focused element, fill an input like a user, press a key, or scroll. Use refs from browser_navigate/browser_snapshot; verify the result afterwards (snapshot or browser_extract).",
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
      execute: wrap(async (args, sessionId) => {
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
          const modifiers = String(args.modifiers || "").split(",").map((part) => part.trim()).filter(Boolean);
          return { action, ...(await page.press(String(args.key || "Enter"), { modifiers })) };
        }
        if (action === "scroll") return { action, ...(await page.scroll({ dx: Number(args.dx) || 0, dy: Number(args.dy) || 0 })) };
        throw new HarnessError("E_BAD_ARG", "unknown action: " + action);
      }),
    }),

    tool({
      name: "browser_extract",
      description:
        "Read from the current page: visible text (text), raw HTML (html), a JavaScript expression result (js), or captured network responses (network). Prefer browser_snapshot for interaction targets and this tool for content/data.",
      parameters: {
        mode: { type: "string", required: true, enum: ["text", "html", "js", "network"], description: "what to read" },
        selector: { type: "string", description: "CSS selector for text/html modes (defaults to body)" },
        expression: { type: "string", description: "JavaScript expression for js mode; string/serialized results are capped at 200k chars with truncated:true" },
        includeBody: { type: "boolean", description: "network mode: include response bodies (slower)" },
        urlContains: { type: "string", description: "network mode: only responses whose URL contains this" },
      },
      output: jsonOutput,
      timeoutMs: 30_000,
      isConcurrencySafe: () => true,
      execute: wrap(async (args, sessionId) => {
        const page = await manager.pageFor(sessionId);
        const mode = String(args.mode);
        if (mode === "text") {
          const value = await page.text(args.selector);
          const text = typeof value === "string" ? value : "";
          const truncated = text.length > 200_000;
          return { mode, value: truncated ? text.slice(0, 200_000) : value, truncated };
        }
        if (mode === "html") {
          const value = await page.evaluate((selector) => {
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
          const matched = page.networkEvents().filter((event) => !args.urlContains || String(event.url || "").includes(String(args.urlContains)));
          const events = matched.slice(-100);
          const capturing = Boolean(page.networkEnabled);
          if (args.includeBody) {
            const withBodies = await page.networkBodies(events);
            return { mode, events: withBodies, count: withBodies.length, capturing };
          }
          return { mode, events, count: events.length, capturing };
        }
        throw new HarnessError("E_BAD_ARG", "unknown mode: " + mode);
      }),
    }),

    tool({
      name: "browser_screenshot",
      description: "Capture a PNG screenshot of the current page and return its file path (open it with an image reader). Use when layout or visual state matters.",
      parameters: {
        fullPage: { type: "boolean", description: "capture beyond the viewport (default false)" },
        path: { type: "string", description: "optional absolute file path for the PNG" },
      },
      output: jsonOutput,
      timeoutMs: 60_000,
      isConcurrencySafe: () => false,
      execute: wrap(async (args, sessionId) => {
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
        targetId: { type: "string", description: "target id for use/close" },
        url: { type: "string", description: "optional URL for new" },
      },
      output: jsonOutput,
      timeoutMs: 30_000,
      isConcurrencySafe: () => false,
      execute: wrap(async (args, sessionId) => {
        const action = String(args.action);
        if (action === "list") return manager.listTabs(sessionId);
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
