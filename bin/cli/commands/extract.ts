import type { CliCommand } from "../registry.js";
import { booleanFlag, rejectUnknownFlags } from "./common.js";

const MODES = ["text", "html", "js", "network", "console", "frames"];
const FLAGS = ["selector", "expression", "include-body", "url-contains", "frame-id", "frame-url"];

export function parseExtractArgs(positional: string[], flags: any) {
  rejectUnknownFlags(flags, FLAGS, "extract");
  const mode = String(positional[0] || "text");
  if (!MODES.includes(mode)) throw new Error("extract needs one of: " + MODES.join(", "));
  const args: any = { mode, ...(flags.selector !== undefined ? { selector: String(flags.selector) } : {}), ...(flags.expression !== undefined ? { expression: String(flags.expression) } : {}), ...(flags["url-contains"] !== undefined ? { urlContains: String(flags["url-contains"]) } : {}), ...(flags["frame-id"] !== undefined ? { frameId: String(flags["frame-id"]) } : {}), ...(flags["frame-url"] !== undefined ? { frameUrl: String(flags["frame-url"]) } : {}) };
  if (flags["include-body"] !== undefined) args.includeBody = booleanFlag(flags["include-body"], "--include-body");
  const extra = positional.slice(1);
  if (mode === "text" || mode === "html") {
    if (extra.length > 1) throw new Error("extract " + mode + " accepts at most one selector");
    if (extra.length === 1) args.selector = extra[0];
  } else if (mode === "js") {
    if (!args.expression && extra.length) args.expression = extra.join(" ");
    if (!args.expression) throw new Error("extract js needs an expression");
  } else if (extra.length > 0) {
    throw new Error("extract " + mode + " does not accept positional arguments");
  }
  if (args.includeBody === true && mode !== "network") throw new Error("extract --include-body is only valid for network");
  if (args.selector !== undefined && mode !== "text" && mode !== "html") throw new Error("extract --selector is only valid for text/html");
  return args;
}

export const extractCommand: CliCommand = {
  name: "extract",
  usage: "extract <text|html|js|network|console|frames> [selector] [flags]",
  async run(ctx, positional, flags) {
    const args = parseExtractArgs(positional, flags);
    const result = await ctx.invoke("browser_extract", args);
    if (args.mode === "text" || args.mode === "html") console.log(result.value === undefined ? result.text : result.value);
    else console.log(JSON.stringify(result, null, 2));
  },
};
