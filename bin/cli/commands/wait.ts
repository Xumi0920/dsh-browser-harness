import type { CliCommand } from "../registry.js";
import { parseWaitArgs } from "./wait-args.js";

export { parseWaitArgs } from "./wait-args.js";

export const waitCommand: CliCommand = {
  name: "wait",
  usage: "wait <selector|selector_hidden|text|text_gone|text_changed|url|url_changed|response|network_idle|delay> [flags]",
  async run(ctx, positional, flags) {
    const args = parseWaitArgs(positional, flags);
    console.log(JSON.stringify(await ctx.invoke("browser_wait", args), null, 2));
  },
};
