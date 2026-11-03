import { booleanFlag, rejectUnknownFlags } from "./common.js";

export function parseGroupsArgs(positional: string[], flags: any) {
  rejectUnknownFlags(flags, ["retry"], "groups");
  if (positional.length > 0) throw new Error("groups accepts no arguments");
  return { retry: booleanFlag(flags.retry, "--retry") };
}
