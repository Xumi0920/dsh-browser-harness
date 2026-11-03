import type { CliCommand } from "../registry.js";
import { parseGroupsArgs } from "./groups-args.js";

export const groupsCommand: CliCommand = {
  name: "groups",
  usage: "groups [--retry] — tab-group status/list",
  async run(ctx, positional, flags) {
    const args = parseGroupsArgs(positional, flags);
    const browser = await ctx.manager.ensure();
    if (args.retry) browser.tabGroups.resetFailure();
    const groups = await browser.tabGroups.listGroups();
    console.log(JSON.stringify({ ...browser.tabGroups.info(), groups }, null, 2));
  },
};
