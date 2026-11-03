import type { CliCommand } from "../registry.js";
import { parseUploadArgs } from "./upload-args.js";

export { parseUploadArgs } from "./upload-args.js";

export const uploadCommand: CliCommand = {
  name: "upload",
  usage: "upload --selector <sel> --path <file> | --paths a,b [--ref <ref>]",
  async run(ctx, positional, flags) {
    const args = parseUploadArgs(positional, flags);
    console.log(JSON.stringify(await ctx.invoke("browser_upload", args), null, 2));
  },
};
