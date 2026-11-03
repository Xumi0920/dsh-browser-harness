import type { CliCommand } from "../registry.js";
import { parseSnapshotArgs } from "./snapshot-args.js";

export { parseSnapshotArgs } from "./snapshot-args.js";

export const snapshotCommand: CliCommand = {
  name: "snapshot",
  usage: "snapshot [--role r --name n --offset 0 --limit 50 --frame-id f --json]",
  async run(ctx, positional, flags) {
    const parsed = parseSnapshotArgs(positional, flags);
    const result = await ctx.invoke("browser_snapshot", parsed.args);
    console.log(parsed.json ? JSON.stringify({ ...result, text: undefined }, null, 2) : result.text);
  },
};
