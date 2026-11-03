import type { CliCommand } from "../registry.js";
import { parseExtractArgs } from "./extract-args.js";

export { parseExtractArgs } from "./extract-args.js";

export const extractCommand: CliCommand = {
  name: "extract",
  usage: "extract <text|html|js|network|console|frames> [selector] [flags]",
  async run(ctx, positional, flags) {
    const args = parseExtractArgs(positional, flags);
    const result = await ctx.invoke("browser_extract", args);
    if (args.mode === "text" || args.mode === "html") console.log(result.value === undefined ? result.text : result.value);
    else console.log(JSON.stringify(result, null, 2));
  },
};
