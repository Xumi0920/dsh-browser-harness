/** Small command registry so CLI subcommands have one skeleton and one help source. */
export interface CliContext {
  manager: any;
  invoke(name: string, args?: any): Promise<any>;
  stateDir: string;
}

export interface CliCommand {
  name: string;
  aliases?: string[];
  needsBrowser?: boolean;
  usage: string;
  run(ctx: CliContext, positional: string[], flags: any): Promise<void>;
}

export type CliCommandTable = CliCommand[];

export function findCommand(table: CliCommandTable, name: string) {
  return table.find((command) => command.name === name || (command.aliases || []).includes(name)) || null;
}

export function commandUsages(table: CliCommandTable) {
  return table.map((command) => command.usage);
}
