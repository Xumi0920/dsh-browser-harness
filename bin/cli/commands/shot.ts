import type { CliCommand } from "../registry.js";

export function parseShotArgs(positional: string[], flags: any) {
  for (const key of Object.keys(flags)) {
    if (key !== "full") throw new Error("unknown option for shot: --" + key);
  }
  if (positional.length > 1) throw new Error("shot accepts at most one path");
  const path = positional[0] === undefined ? undefined : String(positional[0]).trim();
  if (path === "") throw new Error("shot path must not be empty");
  let fullPage = false;
  if (flags.full !== undefined) {
    if (flags.full === true || flags.full === "true") fullPage = true;
    else if (flags.full === "false") fullPage = false;
    else throw new Error("--full expects a boolean");
  }
  return { path, fullPage };
}

export const shotCommand: CliCommand = {
  name: "shot",
  aliases: ["screenshot"],
  usage: "shot [path] [--full] [--full=false] — screenshot inside screenshotDir",
  async run(ctx, positional, flags) {
    const args = parseShotArgs(positional, flags);
    console.log(JSON.stringify(await ctx.invoke("browser_screenshot", { path: args.path, fullPage: args.fullPage }), null, 2));
  },
};
