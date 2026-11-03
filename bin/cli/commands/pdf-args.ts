import { booleanFlag, rejectUnknownFlags } from "./common.js";

export function parsePdfArgs(positional: string[], flags: any) {
  rejectUnknownFlags(flags, ["no-background"], "pdf");
  if (positional.length > 1) throw new Error("pdf accepts at most one path");
  const path = positional[0] === undefined ? undefined : String(positional[0]).trim();
  if (path === "") throw new Error("pdf path must not be empty");
  return { path, printBackground: !booleanFlag(flags["no-background"], "--no-background") };
}
