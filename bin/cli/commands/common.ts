import type { CliContext } from "../registry.js";

export async function currentTarget(ctx: CliContext) {
  const status = await ctx.invoke("browser_status");
  return status.current && status.current.targetId;
}

export function rejectUnknownFlags(flags: any, allowed: string[], command: string) {
  for (const key of Object.keys(flags)) {
    if (!allowed.includes(key)) throw new Error("unknown option for " + command + ": --" + key);
  }
}

export function booleanFlag(value: any, name: string) {
  if (value === undefined) return false;
  if (value === true || value === "true") return true;
  if (value === "false") return false;
  throw new Error(name + " expects a boolean");
}

export function numberValue(value: any, name: string) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(name + " expects a number");
  return number;
}
