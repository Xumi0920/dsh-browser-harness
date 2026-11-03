import type { CliCommand } from "../registry.js";
import { parseActArgs } from "./act-args.js";

export { parseActArgs } from "./act-args.js";

export const actCommand: CliCommand = {
  name: "act",
  usage: "act <click|hover|highlight|drag|type|fill|selectOption|check|uncheck|press|scroll|dialog> [flags]",
  async run(ctx, positional, flags) {
    const args = parseActArgs(positional, flags);
    console.log(JSON.stringify(await ctx.invoke("browser_act", args), null, 2));
  },
};
