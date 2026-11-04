import test from "node:test";
import assert from "node:assert/strict";
import { EXIT_CODES, formatCliError } from "../../dist/bin/cli/contract.js";
import { parseCliArgs } from "../../dist/bin/cli/args.js";
import { snapshotCommand } from "../../dist/bin/cli/commands/snapshot.js";

async function captureLog(fn: () => Promise<any>) {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: any[]) => { lines.push(args.join(" ")); };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

test("CLI exit codes and stderr formatter are stable", () => {
  assert.deepEqual(EXIT_CODES, { OK: 0, FAILURE: 1, USAGE: 2 });
  assert.equal(formatCliError({ code: "E_BAD_ARG", message: "bad arg" }), "E_BAD_ARG: bad arg");
  assert.equal(formatCliError(new Error("plain failure")), "plain failure");
});

test("snapshot command keeps text out of --json output", async () => {
  const result = {
    targetId: "T1", snapshotId: "T1:1", snapshotVersion: 1, generation: "1",
    url: "https://example.com", nodes: 2, total: 2, offset: 0, limit: 50, truncated: false,
    text: "e1 button \"Save\"",
  };
  const ctx = { invoke: async () => result, manager: {} };
  const jsonArgs = parseCliArgs(["--json"]);
  const lines = await captureLog(() => snapshotCommand.run(ctx, jsonArgs.positional, jsonArgs.flags));
  const parsed = JSON.parse(lines.join("\n"));
  assert.equal(parsed.targetId, "T1");
  assert.equal(parsed.generation, "1");
  assert.equal(parsed.text, undefined);
  const humanArgs = parseCliArgs([]);
  const human = await captureLog(() => snapshotCommand.run(ctx, humanArgs.positional, humanArgs.flags));
  assert.equal(human.join("\n"), "e1 button \"Save\"");
});
