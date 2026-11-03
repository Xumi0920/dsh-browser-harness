import { numberFlag } from "../args.js";
import { booleanFlag, rejectUnknownFlags } from "./common.js";
import { SNAPSHOT_FLAGS, SNAPSHOT_MAX_LIMIT, SNAPSHOT_MAX_OFFSET } from "./snapshot-options.js";

function integer(value: any, name: string) {
  if (!Number.isInteger(value)) throw new Error(name + " expects an integer");
  return value;
}

export function parseSnapshotArgs(positional: string[], flags: any) {
  rejectUnknownFlags(flags, SNAPSHOT_FLAGS, "snapshot");
  if (positional.length > 0) throw new Error("snapshot accepts no positional arguments");
  const offset = flags.offset === undefined ? 0 : integer(numberFlag(flags, "offset"), "--offset");
  if (offset < 0) throw new Error("--offset must be zero or greater");
  if (offset > SNAPSHOT_MAX_OFFSET) throw new Error("--offset must be at most " + SNAPSHOT_MAX_OFFSET);
  if (flags.limit !== undefined && flags["max-nodes"] !== undefined) throw new Error("snapshot cannot use both --limit and --max-nodes");
  const rawLimit = flags.limit !== undefined ? numberFlag(flags, "limit") : flags["max-nodes"] !== undefined ? numberFlag(flags, "max-nodes") : 400;
  const limit = integer(rawLimit, "--limit");
  if (limit < 1 || limit > SNAPSHOT_MAX_LIMIT) throw new Error("--limit must be between 1 and " + SNAPSHOT_MAX_LIMIT);
  for (const key of ["role", "name", "frame-id"]) {
    if (flags[key] !== undefined && String(flags[key]).trim() === "") throw new Error("--" + key + " must not be empty");
  }
  return {
    args: {
      offset,
      limit,
      ...(flags.role !== undefined ? { role: String(flags.role) } : {}),
      ...(flags.name !== undefined ? { name: String(flags.name) } : {}),
      ...(flags["frame-id"] !== undefined ? { frameId: String(flags["frame-id"]) } : {}),
    },
    json: booleanFlag(flags.json, "--json"),
  };
}
