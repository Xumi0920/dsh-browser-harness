import type { CliCommand } from "../registry.js";
import { parseSnapshotArgs } from "./snapshot-args.js";
import { renderSnapshotResult } from "./snapshot-render.js";

export { parseSnapshotArgs } from "./snapshot-args.js";

export const snapshotCommand: CliCommand = {
  name: "snapshot",
  usage: "snapshot [--offset n] [--limit n] [--role r] [--name s] [--frame-id f] [--json]\n  offset: default 0, max 100000\n  limit: 1..400, default 400, alias --max-nodes\n  role/name: filter before pagination\n  frame-id: snapshot an iframe\n  --json: metadata without text; also accepts --help",
  async run(ctx, positional, flags) {
    const parsed = parseSnapshotArgs(positional, flags);
    const result = await ctx.invoke("browser_snapshot", parsed.args);
    console.log(renderSnapshotResult(result, parsed.json));
  },
};
