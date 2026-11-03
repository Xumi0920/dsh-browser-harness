#!/usr/bin/env node
/**
 * Standalone CLI over the same tool surface as the DSH plugin:
 *   bh doctor | status | tabs [list|new|use|close] | open <url> | navigate <url>
 *   bh info | snapshot | text [selector] | js <expr> | extract <mode>
 *   bh act <action> | wait <mode> | shot [path] | pdf [path] | diagnose
 *   bh upload --selector ... --path ... | download ... | task <action> | close | groups
 */

import { BrowserManager } from "../lib/manager.js";
import { createTools } from "../lib/tools.js";
import { listEndpoints } from "../src/cdp/endpoint.js";
import { defaultStateDir } from "../src/state.js";

const SESSION = "cli";
const [command, ...rest] = process.argv.slice(2);

function stateDir() {
  return defaultStateDir();
}

function parseArgs(tokens: any): any {
  const flags: any = {};
  const positional: any[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = tokens[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return { flags, positional };
}

function camel(value: string) {
  return String(value).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function pick(flags: any, keys: any): any {
  const out: any = {};
  for (const key of keys) {
    if (flags[key] !== undefined) out[camel(key)] = flags[key];
  }
  return out;
}

function numberFlag(flags: any, key: string) {
  if (flags[key] === undefined) return undefined;
  const value = Number(flags[key]);
  return Number.isFinite(value) ? value : undefined;
}

async function main() {
  if (!command || command === "help" || command === "--help") {
    console.log("usage: bh <doctor|status|tabs|open|navigate|info|snapshot|text|js|extract|act|wait|shot|pdf|diagnose|upload|download|task|close|groups>");
    return;
  }
  if (command === "doctor") {
    const endpoints = await listEndpoints({});
    for (const endpoint of endpoints as any[]) {
      console.log(endpoint.id + "\tport=" + endpoint.port + "\t" + endpoint.status + (endpoint.browser ? "\t" + endpoint.browser : ""));
    }
    return;
  }

  const manager = new BrowserManager({ stateDir: stateDir(), strictTabOwnership: false, fileLease: true });
  const definitions: any[] = createTools({ tools: { register() {} }, effect() {}, get() { return undefined; } }, manager, { maxSnapshotNodes: 400 }, (definition: any) => definition);
  const invoke = async (name: string, args: any = {}) => {
    const definition = definitions.find((item: any) => item.name === name);
    if (!definition) throw new Error("unknown tool: " + name);
    return definition.execute(args, { agent: { session: { id: SESSION } } });
  };
  const { flags, positional } = parseArgs(rest);

  try {
    if (command === "status") {
      console.log(JSON.stringify(await invoke("browser_status"), null, 2));
      return;
    }
    if (command === "open" || command === "navigate") {
      const result = await invoke("browser_navigate", { url: positional[0] || "about:blank", newTab: flags["new-tab"] === true });
      console.log(result.url + "\t" + result.title);
      return;
    }
    if (command === "info") {
      const page = await manager.pageFor(SESSION);
      console.log(JSON.stringify(await page.info(), null, 2));
      return;
    }
    if (command === "tabs") {
      const action = positional[0] && !positional[0].startsWith("--") ? positional[0] : "list";
      if (action === "list") {
        const result = await invoke("browser_tabs", { action: "list" });
        for (const tab of result.tabs) console.log(tab.targetId + "\t" + tab.title + "\t" + tab.url);
        return;
      }
      if (action === "new") {
        console.log(JSON.stringify(await invoke("browser_tabs", { action: "new", url: positional[1] || "about:blank" }), null, 2));
        return;
      }
      if (action === "use") {
        if (!positional[1]) throw new Error("tabs use needs a targetId");
        console.log(JSON.stringify(await invoke("browser_tabs", { action: "use", targetId: positional[1], borrow: flags.borrow === true }), null, 2));
        return;
      }
      if (action === "close") {
        let targetId = positional[1];
        if (!targetId) {
          const status = await invoke("browser_status");
          targetId = status.current && status.current.targetId;
        }
        if (!targetId) throw new Error("no current tab");
        console.log(JSON.stringify(await invoke("browser_tabs", { action: "close", targetId, force: flags.force === true }), null, 2));
        return;
      }
      throw new Error("unknown tabs action: " + action);
    }
    if (command === "close") {
      const status = await invoke("browser_status");
      const targetId = status.current && status.current.targetId;
      if (!targetId) throw new Error("no current tab");
      console.log(JSON.stringify(await invoke("browser_tabs", { action: "close", targetId, force: flags.force === true }), null, 2));
      return;
    }
    if (command === "groups") {
      const browser = await manager.ensure();
      if (flags.retry === true) browser.tabGroups.resetFailure();
      const groups = await browser.tabGroups.listGroups();
      console.log(JSON.stringify({ ...browser.tabGroups.info(), groups }, null, 2));
      return;
    }
    if (command === "snapshot") {
      const args: any = {
        offset: numberFlag(flags, "offset") || 0,
        limit: numberFlag(flags, "limit") || numberFlag(flags, "max-nodes") || 400,
        ...pick(flags, ["role", "name", "frame-id"]),
      };
      const result = await invoke("browser_snapshot", args);
      console.log(flags.json === true ? JSON.stringify({ ...result, text: undefined }, null, 2) : result.text);
      return;
    }
    if (command === "text") {
      const result = await invoke("browser_extract", { mode: "text", selector: positional[0] });
      console.log(result.value);
      return;
    }
    if (command === "js") {
      const result = await invoke("browser_extract", { mode: "js", expression: positional.join(" ") });
      console.log(JSON.stringify(result.value, null, 2));
      return;
    }
    if (command === "extract") {
      const mode = positional[0] || "text";
      const args: any = { mode, ...pick(flags, ["selector", "expression", "include-body", "url-contains", "frame-id", "frame-url"]) };
      if (!args.selector && positional[1] && (mode === "text" || mode === "html")) args.selector = positional[1];
      if (!args.expression && positional.length > 1) args.expression = positional.slice(1).join(" ");
      const result = await invoke("browser_extract", args);
      if (mode === "text" || mode === "html") console.log(result.value === undefined ? result.text : result.value);
      else console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (command === "wait") {
      const mode = positional[0];
      if (!mode) throw new Error("wait needs a mode");
      const args: any = { mode, ...pick(flags, ["selector", "text", "url", "include-body"]), timeoutMs: numberFlag(flags, "timeout-ms"), idleMs: numberFlag(flags, "idle-ms"), delayMs: numberFlag(flags, "delay-ms") };
      if (flags.visible === true) args.visible = true;
      console.log(JSON.stringify(await invoke("browser_wait", args), null, 2));
      return;
    }
    if (command === "act") {
      const action = positional[0];
      if (!action) throw new Error("act needs an action");
      const args: any = { action, ...pick(flags, ["ref", "selector", "x", "y", "text", "key", "modifiers", "dx", "dy", "button", "clicks", "values", "force", "prompt-text", "to-ref", "to-selector", "steps", "expect-url", "expect-text", "expect-selector", "expect-timeout-ms"]) };
      if (args.x !== undefined) args.x = Number(args.x);
      if (args.y !== undefined) args.y = Number(args.y);
      if (args.clicks !== undefined) args.clicks = Number(args.clicks);
      if (args.steps !== undefined) args.steps = Number(args.steps);
      if (args.expectTimeoutMs !== undefined) args.expectTimeoutMs = Number(args.expectTimeoutMs);
      if (args.values !== undefined) args.values = String(args.values).split(",").filter(Boolean);
      if ((args.text === undefined) && positional[1] && (action === "type" || action === "fill")) args.text = positional.slice(1).join(" ");
      if ((args.key === undefined) && positional[1] && action === "press") args.key = positional[1];
      if (args.force !== undefined) args.force = args.force === true || args.force === "true";
      if (action === "dialog") {
        if (flags.dismiss === true) args.accept = false;
        else args.accept = flags.accept !== "false";
        if (flags["prompt-text"] !== undefined) args.promptText = flags["prompt-text"];
      }
      console.log(JSON.stringify(await invoke("browser_act", args), null, 2));
      return;
    }
    if (command === "shot" || command === "screenshot") {
      const result = await invoke("browser_screenshot", { path: positional[0], fullPage: flags.full === true });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (command === "pdf") {
      console.log(JSON.stringify(await invoke("browser_pdf", { path: positional[0], printBackground: flags["no-background"] !== true }), null, 2));
      return;
    }
    if (command === "diagnose") {
      console.log(JSON.stringify(await invoke("browser_diagnose", { screenshot: flags["no-screenshot"] !== true, path: positional[0] }), null, 2));
      return;
    }
    if (command === "upload") {
      const paths = flags.paths ? String(flags.paths).split(",") : flags.path;
      console.log(JSON.stringify(await invoke("browser_upload", { ref: flags.ref, selector: flags.selector, paths }), null, 2));
      return;
    }
    if (command === "download") {
      console.log(JSON.stringify(await invoke("browser_download", { ref: flags.ref, selector: flags.selector, timeoutMs: numberFlag(flags, "timeout-ms") }), null, 2));
      return;
    }
    if (command === "task") {
      const action = positional[0] || "status";
      const args: any = { action, cleanup: flags.cleanup };
      if (flags.cleanup === undefined) delete args.cleanup;
      console.log(JSON.stringify(await invoke("browser_task", args), null, 2));
      return;
    }
    throw new Error("unknown command: " + command);
  } finally {
    await manager.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error((error && error.code ? error.code + ": " : "") + (error && error.message ? error.message : error));
  process.exitCode = 1;
});
