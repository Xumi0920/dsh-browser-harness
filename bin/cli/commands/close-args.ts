import { booleanFlag, rejectUnknownFlags } from "./common.js";

export function parseCloseArgs(positional: string[], flags: any) {
  rejectUnknownFlags(flags, ["force"], "close");
  if (positional.length > 1) throw new Error("close accepts at most one targetId");
  return { targetId: positional[0] || null, force: booleanFlag(flags.force, "--force") };
}
