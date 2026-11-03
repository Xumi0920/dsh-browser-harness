import { assertNavigableUrl } from "../../../src/browser.js";
import type { CliCommand } from "../registry.js";

function booleanFlag(value: any, name: string) {
  if (value === undefined) return false;
  if (value === true || value === "true") return true;
  if (value === "false") return false;
  throw new Error(name + " expects a boolean");
}

export function parseNavigateArgs(positional: string[], flags: any) {
  for (const key of Object.keys(flags)) {
    if (key !== "new-tab") throw new Error("unknown option for navigate: --" + key);
  }
  if (positional.length === 0) throw new Error("navigate needs a URL");
  if (positional.length > 1) throw new Error("navigate accepts exactly one URL");
  const url = String(positional[0]).trim();
  if (!url) throw new Error("navigate needs a non-empty URL");
  assertNavigableUrl(url);
  return { url, newTab: booleanFlag(flags["new-tab"], "--new-tab") };
}

export const navigateCommand: CliCommand = {
  name: "navigate",
  aliases: ["open"],
  usage: "navigate <http(s) URL|about:blank> [--new-tab] — open/reuse a tab",
  async run(ctx, positional, flags) {
    const args = parseNavigateArgs(positional, flags);
    const result = await ctx.invoke("browser_navigate", { url: args.url, newTab: args.newTab });
    console.log(result.url + "\t" + result.title);
  },
};
