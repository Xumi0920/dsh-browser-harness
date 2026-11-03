import { rejectUnknownFlags } from "./common.js";

export function parseJsArgs(positional: string[], flags: any) {
  rejectUnknownFlags(flags, [], "js");
  const expression = positional.join(" ").trim();
  if (!expression) throw new Error("js needs an expression");
  return { expression };
}
