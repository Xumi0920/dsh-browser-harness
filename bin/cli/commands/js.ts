import type { CliCommand } from "../registry.js";
import { parseJsArgs } from "./js-args.js";

export const jsCommand: CliCommand = {
  name: "js",
  usage: "js <expression> — evaluate page JavaScript",
  async run(ctx, positional, flags) {
    const args = parseJsArgs(positional, flags);
    const result = await ctx.invoke("browser_extract", { mode: "js", expression: args.expression });
    console.log(JSON.stringify(result.value, null, 2));
  },
};
