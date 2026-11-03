import type { CliCommand } from "../registry.js";
import { currentTarget } from "./common.js";
import { parseTabsArgs } from "./tabs-args.js";

export { parseTabsArgs } from "./tabs-args.js";

export const tabsCommand: CliCommand = {
  name: "tabs",
  usage: "tabs [list|new [url]|use <targetId> [--borrow]|close [targetId] [--force]]",
  async run(ctx, positional, flags) {
    const args = parseTabsArgs(positional, flags);
    if (args.action === "list") {
      const result = await ctx.invoke("browser_tabs", { action: "list" });
      for (const tab of result.tabs) console.log(tab.targetId + "\t" + tab.title + "\t" + tab.url);
      return;
    }
    if (args.action === "new") {
      console.log(JSON.stringify(await ctx.invoke("browser_tabs", { action: "new", url: args.url }), null, 2));
      return;
    }
    if (args.action === "use") {
      console.log(JSON.stringify(await ctx.invoke("browser_tabs", { action: "use", targetId: args.tab, borrow: args.borrow }), null, 2));
      return;
    }
    const targetId = args.tab || await currentTarget(ctx);
    if (!targetId) throw new Error("no current tab");
    console.log(JSON.stringify(await ctx.invoke("browser_tabs", { action: "close", targetId, force: args.force }), null, 2));
  },
};
