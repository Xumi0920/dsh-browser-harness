#!/usr/bin/env node
/**
 * Standalone CLI over the same tool surface as the DSH plugin.
 * Subcommands live in bin/cli/commands.ts and share one registry skeleton.
 */

import { BrowserManager } from "../lib/manager.js";
import { createTools } from "../lib/tools.js";
import { defaultStateDir } from "../src/state.js";
import { parseCliArgs } from "./cli/args.js";
import { commands } from "./cli/commands.js";
import { commandUsages, findCommand } from "./cli/registry.js";

const [commandName, ...rest] = process.argv.slice(2);

async function main() {
  if (!commandName || commandName === "help" || commandName === "--help") {
    console.log("usage: bh <command> [options]");
    for (const usage of commandUsages(commands)) console.log("  " + usage);
    return;
  }
  const definition = findCommand(commands, commandName);
  if (!definition) {
    console.error("unknown command: " + commandName);
    console.error("usage: bh <command> [options]");
    process.exitCode = 2;
    return;
  }

  const { flags, positional } = parseCliArgs(rest);
  let manager: any = null;
  const context: any = { manager: null, stateDir: defaultStateDir(), invoke: async () => { throw new Error("browser is not available for this command"); } };
  if (definition.needsBrowser !== false) {
    manager = new BrowserManager({ stateDir: context.stateDir, strictTabOwnership: false, fileLease: true });
    const definitions = createTools({ tools: { register() {} }, effect() {}, get() { return undefined; } }, manager, { maxSnapshotNodes: 400 }, (item: any) => item);
    context.manager = manager;
    context.invoke = async (name: string, args: any = {}) => {
      const selected = definitions.find((item: any) => item.name === name);
      if (!selected) throw new Error("unknown tool: " + name);
      return selected.execute(args, { agent: { session: { id: "cli" } } });
    };
  }
  try {
    await definition.run(context, positional, flags);
  } finally {
    if (manager) await manager.close().catch(() => {});
  }
}

main().catch((error: any) => {
  console.error((error && error.code ? error.code + ": " : "") + (error && error.message ? error.message : error));
  process.exitCode = 1;
});
