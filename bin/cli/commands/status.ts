import type { CliCommand } from "../registry.js";
import { rejectAllArgs } from "./common.js";

export const statusCommand: CliCommand = {
  name: "status",
  usage: "status — browser/task status as JSON",
  async run(ctx, positional, flags) {
    rejectAllArgs(positional, flags, "status");
    console.log(JSON.stringify(await ctx.invoke("browser_status"), null, 2));
  },
};
