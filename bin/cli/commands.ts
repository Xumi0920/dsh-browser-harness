import type { CliCommand, CliContext } from "./registry.js";
import { numberFlag, pick } from "./args.js";
import { listEndpoints } from "../../src/cdp/endpoint.js";
import { navigateCommand } from "./commands/navigate.js";
import { shotCommand } from "./commands/shot.js";

async function currentTarget(ctx: CliContext) {
  const status = await ctx.invoke("browser_status");
  return status.current && status.current.targetId;
}

export const commands: CliCommand[] = [
  {
    name: "doctor",
    needsBrowser: false,
    usage: "doctor — list known CDP endpoints and browser status",
    async run() {
      const endpoints = await listEndpoints({});
      for (const endpoint of endpoints as any[]) {
        console.log(endpoint.id + "\tport=" + endpoint.port + "\t" + endpoint.status + (endpoint.browser ? "\t" + endpoint.browser : ""));
      }
    },
  },
  {
    name: "status",
    usage: "status — browser/task status as JSON",
    async run(ctx) {
      console.log(JSON.stringify(await ctx.invoke("browser_status"), null, 2));
    },
  },
  navigateCommand,
  {
    name: "info",
    usage: "info — current page info as JSON",
    async run(ctx) {
      const page = await ctx.manager.pageFor("cli");
      console.log(JSON.stringify(await page.info(), null, 2));
    },
  },
  {
    name: "tabs",
    usage: "tabs [list|new <url>|use <targetId> [--borrow]|close [targetId] [--force]]",
    async run(ctx, positional, flags) {
      const action = positional[0] || "list";
      if (action === "list") {
        const result = await ctx.invoke("browser_tabs", { action: "list" });
        for (const tab of result.tabs) console.log(tab.targetId + "\t" + tab.title + "\t" + tab.url);
        return;
      }
      if (action === "new") {
        console.log(JSON.stringify(await ctx.invoke("browser_tabs", { action: "new", url: positional[1] || "about:blank" }), null, 2));
        return;
      }
      if (action === "use") {
        if (!positional[1]) throw new Error("tabs use needs a targetId");
        console.log(JSON.stringify(await ctx.invoke("browser_tabs", { action: "use", targetId: positional[1], borrow: flags.borrow === true }), null, 2));
        return;
      }
      if (action === "close") {
        const targetId = positional[1] || await currentTarget(ctx);
        if (!targetId) throw new Error("no current tab");
        console.log(JSON.stringify(await ctx.invoke("browser_tabs", { action: "close", targetId, force: flags.force === true }), null, 2));
        return;
      }
      throw new Error("unknown tabs action: " + action);
    },
  },
  {
    name: "close",
    usage: "close [targetId] [--force] — close current/owned tab",
    async run(ctx, positional, flags) {
      const targetId = positional[0] || await currentTarget(ctx);
      if (!targetId) throw new Error("no current tab");
      console.log(JSON.stringify(await ctx.invoke("browser_tabs", { action: "close", targetId, force: flags.force === true }), null, 2));
    },
  },
  {
    name: "groups",
    usage: "groups [--retry] — tab-group status/list",
    async run(ctx, _positional, flags) {
      const browser = await ctx.manager.ensure();
      if (flags.retry === true) browser.tabGroups.resetFailure();
      const groups = await browser.tabGroups.listGroups();
      console.log(JSON.stringify({ ...browser.tabGroups.info(), groups }, null, 2));
    },
  },
  {
    name: "snapshot",
    usage: "snapshot [--role r --name n --offset 0 --limit 50 --frame-id f --json]",
    async run(ctx, _positional, flags) {
      const args: any = {
        offset: numberFlag(flags, "offset") || 0,
        limit: numberFlag(flags, "limit") || numberFlag(flags, "max-nodes") || 400,
        ...pick(flags, ["role", "name", "frame-id"]),
      };
      const result = await ctx.invoke("browser_snapshot", args);
      console.log(flags.json === true ? JSON.stringify({ ...result, text: undefined }, null, 2) : result.text);
    },
  },
  {
    name: "text",
    usage: "text [selector] — visible text",
    async run(ctx, positional) {
      const result = await ctx.invoke("browser_extract", { mode: "text", selector: positional[0] });
      console.log(result.value);
    },
  },
  {
    name: "js",
    usage: "js <expression> — evaluate page JavaScript",
    async run(ctx, positional) {
      const result = await ctx.invoke("browser_extract", { mode: "js", expression: positional.join(" ") });
      console.log(JSON.stringify(result.value, null, 2));
    },
  },
  {
    name: "extract",
    usage: "extract <text|html|js|network|console|frames> [selector] [flags]",
    async run(ctx, positional, flags) {
      const mode = positional[0] || "text";
      const args: any = { mode, ...pick(flags, ["selector", "expression", "include-body", "url-contains", "frame-id", "frame-url"]) };
      if (!args.selector && positional[1] && (mode === "text" || mode === "html")) args.selector = positional[1];
      if (!args.expression && positional.length > 1) args.expression = positional.slice(1).join(" ");
      const result = await ctx.invoke("browser_extract", args);
      if (mode === "text" || mode === "html") console.log(result.value === undefined ? result.text : result.value);
      else console.log(JSON.stringify(result, null, 2));
    },
  },
  {
    name: "wait",
    usage: "wait <mode> [--selector ...|--text ...|--url ...|--timeout-ms ...]",
    async run(ctx, positional, flags) {
      const mode = positional[0];
      if (!mode) throw new Error("wait needs a mode");
      const args: any = { mode, ...pick(flags, ["selector", "text", "url", "include-body"]), timeoutMs: numberFlag(flags, "timeout-ms"), idleMs: numberFlag(flags, "idle-ms"), delayMs: numberFlag(flags, "delay-ms") };
      if (flags.visible === true) args.visible = true;
      console.log(JSON.stringify(await ctx.invoke("browser_wait", args), null, 2));
    },
  },
  {
    name: "act",
    usage: "act <click|hover|highlight|drag|type|fill|selectOption|check|uncheck|press|scroll|dialog> [flags]",
    async run(ctx, positional, flags) {
      const action = positional[0];
      if (!action) throw new Error("act needs an action");
      const args: any = { action, ...pick(flags, ["ref", "selector", "x", "y", "text", "key", "modifiers", "dx", "dy", "button", "clicks", "values", "force", "prompt-text", "to-ref", "to-selector", "steps", "expect-url", "expect-text", "expect-selector", "expect-timeout-ms"]) };
      if (args.x !== undefined) args.x = Number(args.x);
      if (args.y !== undefined) args.y = Number(args.y);
      if (args.clicks !== undefined) args.clicks = Number(args.clicks);
      if (args.steps !== undefined) args.steps = Number(args.steps);
      if (args.expectTimeoutMs !== undefined) args.expectTimeoutMs = Number(args.expectTimeoutMs);
      if (args.values !== undefined) args.values = String(args.values).split(",").filter(Boolean);
      if (args.text === undefined && positional[1] && (action === "type" || action === "fill")) args.text = positional.slice(1).join(" ");
      if (args.key === undefined && positional[1] && action === "press") args.key = positional[1];
      if (args.force !== undefined) args.force = args.force === true || args.force === "true";
      if (action === "dialog") {
        if (flags.dismiss === true) args.accept = false;
        else args.accept = flags.accept !== "false";
        if (flags["prompt-text"] !== undefined) args.promptText = flags["prompt-text"];
      }
      console.log(JSON.stringify(await ctx.invoke("browser_act", args), null, 2));
    },
  },
  shotCommand,
  {
    name: "pdf",
    usage: "pdf [path] [--no-background]",
    async run(ctx, positional, flags) {
      console.log(JSON.stringify(await ctx.invoke("browser_pdf", { path: positional[0], printBackground: flags["no-background"] !== true }), null, 2));
    },
  },
  {
    name: "diagnose",
    usage: "diagnose [path] [--no-screenshot]",
    async run(ctx, positional, flags) {
      console.log(JSON.stringify(await ctx.invoke("browser_diagnose", { screenshot: flags["no-screenshot"] !== true, path: positional[0] }), null, 2));
    },
  },
  {
    name: "upload",
    usage: "upload --selector <sel> --path <file> | --paths a,b",
    async run(ctx, _positional, flags) {
      const paths = flags.paths ? String(flags.paths).split(",") : flags.path;
      console.log(JSON.stringify(await ctx.invoke("browser_upload", { ref: flags.ref, selector: flags.selector, paths }), null, 2));
    },
  },
  {
    name: "download",
    usage: "download --selector <sel> | --ref <ref>",
    async run(ctx, _positional, flags) {
      console.log(JSON.stringify(await ctx.invoke("browser_download", { ref: flags.ref, selector: flags.selector, timeoutMs: numberFlag(flags, "timeout-ms") }), null, 2));
    },
  },
  {
    name: "task",
    usage: "task <status|start|pause|resume|close> [--cleanup ...]",
    async run(ctx, positional, flags) {
      const action = positional[0] || "status";
      const args: any = { action };
      if (flags.cleanup !== undefined) args.cleanup = flags.cleanup;
      console.log(JSON.stringify(await ctx.invoke("browser_task", args), null, 2));
    },
  },
];
