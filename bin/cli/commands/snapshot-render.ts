/** Render a browser_snapshot result for the CLI without duplicating output policy. */
export function renderSnapshotResult(result: any, json: boolean) {
  if (json) return JSON.stringify({ ...result, text: undefined }, null, 2);
  return String(result.text ?? "");
}
