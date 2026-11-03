export function parseSnapshotFilters(flags: any) {
  for (const key of ["role", "name", "frame-id"]) {
    if (flags[key] !== undefined && String(flags[key]).trim() === "") throw new Error("--" + key + " must not be empty");
  }
  return {
    ...(flags.role !== undefined ? { role: String(flags.role) } : {}),
    ...(flags.name !== undefined ? { name: String(flags.name) } : {}),
    ...(flags["frame-id"] !== undefined ? { frameId: String(flags["frame-id"]) } : {}),
  };
}
