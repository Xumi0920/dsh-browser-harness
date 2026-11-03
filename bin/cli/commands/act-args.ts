import { booleanFlag, numberValue, rejectUnknownFlags } from "./common.js";

const ACTIONS = ["click", "hover", "highlight", "drag", "type", "fill", "selectOption", "check", "uncheck", "press", "scroll", "dialog"];
const FLAGS = [
  "ref", "selector", "x", "y", "text", "key", "modifiers", "dx", "dy", "button", "clicks",
  "values", "force", "prompt-text", "to-ref", "to-selector", "steps", "accept", "dismiss",
  "expect-url", "expect-text", "expect-selector", "expect-timeout-ms",
];

export function parseActArgs(positional: string[], flags: any) {
  rejectUnknownFlags(flags, FLAGS, "act");
  const action = String(positional[0] || "");
  if (!ACTIONS.includes(action)) throw new Error("act needs one of: " + ACTIONS.join(", "));
  const args: any = { action };
  for (const key of ["ref", "selector", "text", "key", "modifiers", "button", "expect-url", "expect-text", "expect-selector"]) {
    if (flags[key] !== undefined) args[key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = flags[key];
  }
  const numberKeys = ["x", "y", "clicks", "steps", "dx", "dy", "expect-timeout-ms"];
  for (const key of numberKeys) {
    if (flags[key] !== undefined) args[key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = numberValue(flags[key], "--" + key);
  }
  if (flags.values !== undefined) {
    args.values = String(flags.values).split(",").map((value) => value.trim()).filter(Boolean);
    if (args.values.length === 0) throw new Error("act selectOption needs a non-empty --values");
  }
  if (flags.force !== undefined) args.force = booleanFlag(flags.force, "--force");
  if (flags["prompt-text"] !== undefined) args.promptText = String(flags["prompt-text"]);
  if (flags["to-ref"] !== undefined) args.toRef = String(flags["to-ref"]);
  if (flags["to-selector"] !== undefined) args.toSelector = String(flags["to-selector"]);
  const hasTarget = Boolean(args.ref || args.selector);
  const extra = positional.slice(1);
  if (extra.length > 0) {
    if (action === "type" || action === "fill") args.text = args.text === undefined ? extra.join(" ") : args.text;
    else if (action === "press" && args.key === undefined) args.key = extra[0];
    else throw new Error("act " + action + " does not accept positional arguments");
  }
  if (action === "click") {
    if (!hasTarget && (args.x === undefined || args.y === undefined)) throw new Error("act click needs ref/selector or x and y");
  } else if (action === "hover" || action === "highlight" || action === "fill" || action === "selectOption" || action === "check" || action === "uncheck") {
    if (!hasTarget) throw new Error("act " + action + " needs --ref or --selector");
  } else if (action === "drag") {
    if (!hasTarget) throw new Error("act drag needs --ref or --selector");
    if (!args.toRef && !args.toSelector) throw new Error("act drag needs --to-ref or --to-selector");
    if (args.steps !== undefined && (args.steps < 1 || args.steps > 100)) throw new Error("act --steps must be between 1 and 100");
  } else if (action === "press") {
    if (args.key === undefined) args.key = "Enter";
  } else if (action === "scroll") {
    args.dx = args.dx === undefined ? 0 : args.dx;
    args.dy = args.dy === undefined ? 0 : args.dy;
  } else if (action === "dialog") {
    if (flags.accept !== undefined && flags.dismiss !== undefined) throw new Error("act dialog cannot use both --accept and --dismiss");
    if (flags.dismiss !== undefined) args.accept = false;
    else if (flags.accept !== undefined) args.accept = booleanFlag(flags.accept, "--accept");
    else args.accept = true;
  }
  if (action === "selectOption" && (!Array.isArray(args.values) || args.values.length === 0)) throw new Error("act selectOption needs --values a,b");
  if (args.button !== undefined && !["left", "right", "middle"].includes(args.button)) throw new Error("act --button must be left, right or middle");
  if (args.expectTimeoutMs !== undefined && (args.expectTimeoutMs < 100 || args.expectTimeoutMs > 30_000)) throw new Error("act --expect-timeout-ms must be between 100 and 30000");
  return args;
}
