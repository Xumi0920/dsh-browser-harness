import test from "node:test";
import assert from "node:assert/strict";
import { camel, numberFlag, parseCliArgs, pick } from "../../dist/bin/cli/args.js";
import { commands } from "../../dist/bin/cli/commands.js";
import { commandUsages, findCommand } from "../../dist/bin/cli/registry.js";

test("CLI argument parser handles flags, values, booleans and positionals", () => {
  const parsed = parseCliArgs(["navigate", "https://example.com", "--new-tab", "--limit", "5", "--full"]);
  assert.deepEqual(parsed.positional, ["navigate", "https://example.com"]);
  assert.equal(parsed.flags["new-tab"], true);
  assert.equal(parsed.flags.limit, "5");
  assert.equal(parsed.flags.full, true);
  assert.equal(camel("expect-text"), "expectText");
  assert.deepEqual(pick(parsed.flags, ["new-tab", "limit"]), { newTab: true, limit: "5" });
  assert.equal(numberFlag(parsed.flags, "limit"), 5);
  assert.equal(numberFlag(parsed.flags, "missing"), undefined);
});

test("CLI command skeleton exposes aliases and one usage line per command", () => {
  assert.equal(findCommand(commands, "open").name, "navigate");
  assert.equal(findCommand(commands, "screenshot").name, "shot");
  assert.equal(findCommand(commands, "missing"), null);
  const names = commands.map((command) => command.name);
  for (const name of ["doctor", "status", "navigate", "snapshot", "act", "extract", "wait", "tabs", "task", "shot", "pdf", "diagnose", "upload", "download"]) {
    assert.ok(names.includes(name), name);
  }
  assert.equal(commandUsages(commands).length, commands.length);
});
