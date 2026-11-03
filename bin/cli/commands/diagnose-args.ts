import { booleanFlag, rejectUnknownFlags } from "./common.js";

export function parseDiagnoseArgs(positional: string[], flags: any) {
  rejectUnknownFlags(flags, ["no-screenshot"], "diagnose");
  if (positional.length > 1) throw new Error("diagnose accepts at most one path");
  const path = positional[0] === undefined ? undefined : String(positional[0]).trim();
  if (path === "") throw new Error("diagnose path must not be empty");
  return { screenshot: !booleanFlag(flags["no-screenshot"], "--no-screenshot"), path };
}
