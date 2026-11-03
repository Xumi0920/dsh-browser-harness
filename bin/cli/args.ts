/** Argument parsing shared by every bh subcommand. */
export interface ParsedArgs {
  flags: any;
  positional: string[];
}

export function parseCliArgs(tokens: string[]): ParsedArgs {
  const flags: any = {};
  const positional: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = tokens[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return { flags, positional };
}

export function camel(value: string) {
  return String(value).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

export function pick(flags: any, keys: string[]): any {
  const out: any = {};
  for (const key of keys) {
    if (flags[key] !== undefined) out[camel(key)] = flags[key];
  }
  return out;
}

export function numberFlag(flags: any, key: string) {
  if (flags[key] === undefined) return undefined;
  const value = Number(flags[key]);
  return Number.isFinite(value) ? value : undefined;
}
