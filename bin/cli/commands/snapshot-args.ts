import { booleanFlag, rejectUnknownFlags } from "./common.js";
import { SNAPSHOT_FLAGS } from "./snapshot-options.js";
import { parseSnapshotFilters } from "./snapshot-filters.js";
import { parseSnapshotPagination } from "./snapshot-pagination.js";

export function parseSnapshotArgs(positional: string[], flags: any) {
  rejectUnknownFlags(flags, SNAPSHOT_FLAGS, "snapshot");
  if (positional.length > 0) throw new Error("snapshot accepts no positional arguments");
  return {
    args: { ...parseSnapshotPagination(flags), ...parseSnapshotFilters(flags) },
    json: booleanFlag(flags.json, "--json"),
  };
}
