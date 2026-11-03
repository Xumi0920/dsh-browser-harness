import { rejectUnknownFlags } from "./common.js";

const ACTIONS = ["status", "start", "pause", "resume", "close"];

export function parseTaskArgs(positional: string[], flags: any) {
  const action = String(positional[0] || "status");
  if (!ACTIONS.includes(action)) throw new Error("task needs one of: " + ACTIONS.join(", "));
  if (positional.length > 1) throw new Error("task accepts one action only");
  rejectUnknownFlags(flags, action === "close" ? ["cleanup"] : [], "task " + action);
  const args: any = { action };
  if (action === "close" && flags.cleanup !== undefined) {
    const cleanup = String(flags.cleanup);
    if (cleanup !== "close-owned" && cleanup !== "leave") throw new Error("task --cleanup must be close-owned or leave");
    args.cleanup = cleanup;
  }
  return args;
}
