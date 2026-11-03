import type { CliCommand } from "../registry.js";
import { rejectAllArgs } from "./common.js";

export const infoCommand: CliCommand = {
  name: "info",
  usage: "info — current page info as JSON",
  async run(ctx, positional, flags) {
    rejectAllArgs(positional, flags, "info");
    const page = await ctx.manager.pageFor("cli");
    console.log(JSON.stringify(await page.info(), null, 2));
  },
};
