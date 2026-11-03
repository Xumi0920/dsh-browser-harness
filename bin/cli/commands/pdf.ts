import type { CliCommand } from "../registry.js";
import { parsePdfArgs } from "./pdf-args.js";

export const pdfCommand: CliCommand = {
  name: "pdf",
  usage: "pdf [path] [--no-background]",
  async run(ctx, positional, flags) {
    const args = parsePdfArgs(positional, flags);
    console.log(JSON.stringify(await ctx.invoke("browser_pdf", args), null, 2));
  },
};
