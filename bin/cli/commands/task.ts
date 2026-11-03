import type { CliCommand } from "../registry.js";
import { parseTaskArgs } from "./task-args.js";

export { parseTaskArgs } from "./task-args.js";

export const taskCommand: CliCommand = {
  name: "task",
  usage: "task <status|start|pause|resume|close> [--cleanup close-owned|leave]",
  async run(ctx, positional, flags) {
    const args = parseTaskArgs(positional, flags);
    console.log(JSON.stringify(await ctx.invoke("browser_task", args), null, 2));
  },
};
