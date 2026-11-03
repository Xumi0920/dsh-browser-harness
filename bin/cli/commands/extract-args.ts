import { booleanFlag } from "./common.js";
import { EXTRACT_MODES, validateExtractFlags } from "./extract-options.js";

export function parseExtractArgs(positional: string[], flags: any) {
  const mode = String(positional[0] || "text");
  if (!EXTRACT_MODES.includes(mode)) throw new Error("extract needs one of: " + EXTRACT_MODES.join(", "));
  validateExtractFlags(mode, flags);
  const args: any = {
    mode,
    ...(flags.selector !== undefined ? { selector: String(flags.selector) } : {}),
    ...(flags.expression !== undefined ? { expression: String(flags.expression) } : {}),
    ...(flags["url-contains"] !== undefined ? { urlContains: String(flags["url-contains"]) } : {}),
    ...(flags["frame-id"] !== undefined ? { frameId: String(flags["frame-id"]) } : {}),
    ...(flags["frame-url"] !== undefined ? { frameUrl: String(flags["frame-url"]) } : {}),
  };
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
  return args;
}
