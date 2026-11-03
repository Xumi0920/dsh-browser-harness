import type { CliCommand } from "../registry.js";
import { parseTextArgs } from "./text-args.js";

export const textCommand: CliCommand = {
  name: "text",
  usage: "text [selector] — visible text",
  async run(ctx, positional, flags) {
    const args = parseTextArgs(positional, flags);
    const result = await ctx.invoke("browser_extract", { mode: "text", selector: args.selector });
    console.log(result.value);
  },
};
