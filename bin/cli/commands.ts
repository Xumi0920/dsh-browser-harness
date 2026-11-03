import type { CliCommand, CliContext } from "./registry.js";
import { listEndpoints } from "../../src/cdp/endpoint.js";
import { navigateCommand } from "./commands/navigate.js";
import { shotCommand } from "./commands/shot.js";
import { actCommand } from "./commands/act.js";
import { extractCommand } from "./commands/extract.js";
import { tabsCommand } from "./commands/tabs.js";
import { snapshotCommand } from "./commands/snapshot.js";
import { uploadCommand } from "./commands/upload.js";
import { downloadCommand } from "./commands/download.js";
import { waitCommand } from "./commands/wait.js";
import { taskCommand } from "./commands/task.js";

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
  tabsCommand,
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
  snapshotCommand,
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
  extractCommand,
  waitCommand,
  actCommand,
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
  uploadCommand,
  downloadCommand,
  taskCommand,
];
