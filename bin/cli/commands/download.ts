import type { CliCommand } from "../registry.js";
import { parseDownloadArgs } from "./download-args.js";

export { parseDownloadArgs } from "./download-args.js";

export const downloadCommand: CliCommand = {
  name: "download",
  usage: "download --selector <sel> | --ref <ref> [--timeout-ms n]",
  async run(ctx, positional, flags) {
    const args = parseDownloadArgs(positional, flags);
    console.log(JSON.stringify(await ctx.invoke("browser_download", args), null, 2));
  },
};
