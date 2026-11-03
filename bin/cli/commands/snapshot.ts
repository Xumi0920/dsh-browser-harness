import type { CliCommand } from "../registry.js";
import { parseSnapshotArgs } from "./snapshot-args.js";
import { renderSnapshotResult } from "./snapshot-render.js";

export { parseSnapshotArgs } from "./snapshot-args.js";

export const snapshotCommand: CliCommand = {
  name: "snapshot",
  usage: "snapshot [--role r --name n --offset 0 --limit 50 --frame-id f --json]",
  async run(ctx, positional, flags) {
    const parsed = parseSnapshotArgs(positional, flags);
    const result = await ctx.invoke("browser_snapshot", parsed.args);
    console.log(renderSnapshotResult(result, parsed.json));
  },
};
