import type { CliCommand } from "../registry.js";
import { parseDiagnoseArgs } from "./diagnose-args.js";

export const diagnoseCommand: CliCommand = {
  name: "diagnose",
  usage: "diagnose [path] [--no-screenshot]",
  async run(ctx, positional, flags) {
    const args = parseDiagnoseArgs(positional, flags);
    console.log(JSON.stringify(await ctx.invoke("browser_diagnose", args), null, 2));
  },
};
