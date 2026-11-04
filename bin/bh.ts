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
import { EXIT_CODES, formatCliError } from "./cli/contract.js";

const [commandName, ...rest] = process.argv.slice(2);

function printCommands() {
  console.log("usage: bh <command> [options]");
  for (const usage of commandUsages(commands)) console.log("  " + usage);
}

async function main() {
  if (!commandName || commandName === "help" || commandName === "--help") {
    const requested = commandName === "help" ? parseCliArgs(rest).positional[0] : null;
    if (requested) {
      const selected = findCommand(commands, requested);
      if (!selected) {
        console.error("unknown command: " + requested);
        process.exitCode = EXIT_CODES.USAGE;
        return;
      }
      console.log(selected.usage);
      return;
    }
    printCommands();
    return;
  }
  const definition = findCommand(commands, commandName);
  if (!definition) {
    console.error("unknown command: " + commandName);
    printCommands();
    process.exitCode = EXIT_CODES.USAGE;
    return;
  }

  const { flags, positional } = parseCliArgs(rest);
  if (flags.help === true) {
    console.log(definition.usage);
    return;
  }
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
  console.error(formatCliError(error));
  process.exitCode = EXIT_CODES.FAILURE;
});
