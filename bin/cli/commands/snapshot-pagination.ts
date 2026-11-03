import { numberFlag } from "../args.js";
import { SNAPSHOT_MAX_LIMIT, SNAPSHOT_MAX_OFFSET } from "./snapshot-options.js";

function integer(value: any, name: string) {
  if (!Number.isInteger(value)) throw new Error(name + " expects an integer");
  return value;
}

export function parseSnapshotPagination(flags: any) {
  const offset = flags.offset === undefined ? 0 : integer(numberFlag(flags, "offset"), "--offset");
  if (offset < 0) throw new Error("--offset must be zero or greater");
  if (offset > SNAPSHOT_MAX_OFFSET) throw new Error("--offset must be at most " + SNAPSHOT_MAX_OFFSET);
  if (flags.limit !== undefined && flags["max-nodes"] !== undefined) throw new Error("snapshot cannot use both --limit and --max-nodes");
  const rawLimit = flags.limit !== undefined ? numberFlag(flags, "limit") : flags["max-nodes"] !== undefined ? numberFlag(flags, "max-nodes") : SNAPSHOT_MAX_LIMIT;
  const limit = integer(rawLimit, "--limit");
  if (limit < 1 || limit > SNAPSHOT_MAX_LIMIT) throw new Error("--limit must be between 1 and " + SNAPSHOT_MAX_LIMIT);
  return { offset, limit };
}
