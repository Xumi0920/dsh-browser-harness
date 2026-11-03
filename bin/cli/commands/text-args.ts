import { rejectUnknownFlags } from "./common.js";

export function parseTextArgs(positional: string[], flags: any) {
  rejectUnknownFlags(flags, [], "text");
  if (positional.length > 1) throw new Error("text accepts at most one selector");
  const selector = positional[0] === undefined ? undefined : String(positional[0]).trim();
  if (selector === "") throw new Error("text selector must not be empty");
  return { selector };
}
