import { numberFlag } from "../args.js";
import { rejectUnknownFlags } from "./common.js";

const FLAGS = ["ref", "selector", "timeout-ms"];

export function parseDownloadArgs(positional: string[], flags: any) {
  rejectUnknownFlags(flags, FLAGS, "download");
  if (positional.length > 0) throw new Error("download accepts no positional arguments");
  if (flags.ref && flags.selector) throw new Error("download accepts --ref or --selector, not both");
  if (!flags.ref && !flags.selector) throw new Error("download needs --ref or --selector");
  let timeoutMs: number | undefined;
  if (flags["timeout-ms"] !== undefined) {
    const parsed = numberFlag(flags, "timeout-ms");
    if (parsed === undefined || !Number.isInteger(parsed) || parsed < 1 || parsed > 120_000) throw new Error("--timeout-ms must be an integer between 1 and 120000");
    timeoutMs = parsed;
  }
  return { ref: flags.ref, selector: flags.selector, timeoutMs };
}
