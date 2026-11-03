import { numberFlag } from "../args.js";
import { booleanFlag, rejectUnknownFlags } from "./common.js";

const MODES = ["selector", "selector_hidden", "text", "text_gone", "text_changed", "url", "url_changed", "response", "network_idle", "delay"];
const FLAGS_BY_MODE: Record<string, string[]> = {
  selector: ["selector", "visible", "timeout-ms"],
  selector_hidden: ["selector", "timeout-ms"],
  text: ["text", "timeout-ms"],
  text_gone: ["text", "timeout-ms"],
  text_changed: ["text", "timeout-ms"],
  url: ["url", "timeout-ms"],
  url_changed: ["url", "timeout-ms"],
  response: ["url", "include-body", "timeout-ms"],
  network_idle: ["idle-ms", "timeout-ms"],
  delay: ["delay-ms", "timeout-ms"],
};

function optionalInteger(flags: any, key: string, min: number, max: number) {
  if (flags[key] === undefined) return undefined;
  const value = numberFlag(flags, key);
  if (value === undefined || !Number.isInteger(value) || value < min || value > max) throw new Error("--" + key + " must be an integer between " + min + " and " + max);
  return value;
}

export function parseWaitArgs(positional: string[], flags: any) {
  const mode = String(positional[0] || "");
  if (!MODES.includes(mode)) throw new Error("wait needs one of: " + MODES.join(", "));
  if (positional.length > 1) throw new Error("wait accepts a mode and flags only");
  rejectUnknownFlags(flags, FLAGS_BY_MODE[mode], "wait " + mode);
  const args: any = { mode };
  for (const key of ["selector", "text", "url"]) {
    if (flags[key] !== undefined) {
      if (String(flags[key]).trim() === "") throw new Error("--" + key + " must not be empty");
      args[key] = String(flags[key]);
    }
  }
  if (mode === "selector" && !args.selector) throw new Error("wait selector needs --selector");
  if (mode === "selector_hidden" && !args.selector) throw new Error("wait selector_hidden needs --selector");
  if (["text", "text_gone", "text_changed"].includes(mode) && !args.text) throw new Error("wait " + mode + " needs --text");
  if (["url", "url_changed", "response"].includes(mode) && !args.url) throw new Error("wait " + mode + " needs --url");
  if (flags.visible !== undefined) args.visible = booleanFlag(flags.visible, "--visible");
  if (flags["include-body"] !== undefined) args.includeBody = booleanFlag(flags["include-body"], "--include-body");
  const timeoutMs = optionalInteger(flags, "timeout-ms", 100, 120_000);
  const idleMs = optionalInteger(flags, "idle-ms", 0, 120_000);
  const delayMs = optionalInteger(flags, "delay-ms", 0, 120_000);
  if (timeoutMs !== undefined) args.timeoutMs = timeoutMs;
  if (idleMs !== undefined) args.idleMs = idleMs;
  if (delayMs !== undefined) args.delayMs = delayMs;
  return args;
}
