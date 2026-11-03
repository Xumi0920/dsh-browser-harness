import type { CliCommand } from "../registry.js";
import { currentTarget } from "./common.js";
import { parseCloseArgs } from "./close-args.js";

export const closeCommand: CliCommand = {
  name: "close",
  usage: "close [targetId] [--force] — close current/owned tab",
  async run(ctx, positional, flags) {
    const args = parseCloseArgs(positional, flags);
    const targetId = args.targetId || await currentTarget(ctx);
    if (!targetId) throw new Error("no current tab");
    console.log(JSON.stringify(await ctx.invoke("browser_tabs", { action: "close", targetId, force: args.force }), null, 2));
  },
};
