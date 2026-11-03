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

test("navigate subcommand validates URL and options", async () => {
  const { parseNavigateArgs } = await import("../../dist/bin/cli/commands/navigate.js");
  const nav = (tokens: string[]) => {
    const parsed = parseCliArgs(tokens);
    return parseNavigateArgs(parsed.positional, parsed.flags);
  };
  assert.deepEqual(nav(["https://example.com"]), { url: "https://example.com", newTab: false });
  assert.deepEqual(nav(["about:blank", "--new-tab"]), { url: "about:blank", newTab: true });
  assert.throws(() => nav([]), /needs a URL/);
  assert.throws(() => nav(["https://a", "https://b"]), /exactly one URL/);
  assert.throws(() => nav(["https://a", "--bogus"]), /unknown option/);
  assert.throws(() => nav(["file:///etc/passwd"]), /refusing to open/);
  assert.throws(() => nav(["https://a", "--new-tab=maybe"]), /expects a boolean/);
});

test("shot subcommand validates path and flags", async () => {
  const { parseShotArgs } = await import("../../dist/bin/cli/commands/shot.js");
  const shot = (tokens: string[]) => {
    const parsed = parseCliArgs(tokens);
    return parseShotArgs(parsed.positional, parsed.flags);
  };
  assert.deepEqual(shot([]), { path: undefined, fullPage: false });
  assert.deepEqual(shot(["page.png", "--full"]), { path: "page.png", fullPage: true });
  assert.deepEqual(shot(["--full=false"]), { path: undefined, fullPage: false });
  assert.throws(() => shot(["a.png", "b.png"]), /at most one path/);
  assert.throws(() => shot([""]), /must not be empty/);
  assert.throws(() => shot(["a.png", "--nope"]), /unknown option/);
  assert.throws(() => shot(["--full=maybe"]), /expects a boolean/);
});

test("act subcommand validates action-specific targets and values", async () => {
  const { parseActArgs } = await import("../../dist/bin/cli/commands/act.js");
  const act = (tokens: string[]) => {
    const parsed = parseCliArgs(tokens);
    return parseActArgs(parsed.positional, parsed.flags);
  };
  assert.deepEqual(act(["click", "--selector", "#submit"]).action, "click");
  assert.deepEqual(act(["fill", "--selector", "#name", "--text", "Ada"]).text, "Ada");
  assert.deepEqual(act(["drag", "--selector", "#a", "--to-selector", "#b", "--steps", "4"]).steps, 4);
  assert.deepEqual(act(["selectOption", "--selector", "#color", "--values", "red,blue"]).values, ["red", "blue"]);
  assert.equal(act(["press", "Enter"]).key, "Enter");
  assert.throws(() => act([]), /needs one of/);
  assert.throws(() => act(["click"]), /needs ref\/selector or x and y/);
  assert.throws(() => act(["drag", "--selector", "#a"]), /needs --to-ref or --to-selector/);
  assert.throws(() => act(["fill", "--selector", "#name", "--bogus"]), /unknown option/);
  assert.throws(() => act(["hover", "--values", "a"]), /unknown option/);
  assert.throws(() => act(["dialog", "--force"]), /unknown option/);
  assert.throws(() => act(["scroll", "--dx", "wat"]), /expects a number/);
});

test("extract subcommand validates mode, selector and expression", async () => {
  const { parseExtractArgs } = await import("../../dist/bin/cli/commands/extract.js");
  const extract = (tokens: string[]) => {
    const parsed = parseCliArgs(tokens);
    return parseExtractArgs(parsed.positional, parsed.flags);
  };
  assert.deepEqual(extract(["text", "#result"]).selector, "#result");
  assert.equal(extract(["js", "document.title"]).expression, "document.title");
  assert.equal(extract(["network", "--include-body"]).includeBody, true);
  assert.equal(extract([]).mode, "text");
  assert.throws(() => extract(["bogus"]), /one of/);
  assert.throws(() => extract(["js"]), /needs an expression/);
  assert.throws(() => extract(["text", "#a", "#b"]), /at most one selector/);
  assert.throws(() => extract(["network", "#a"]), /does not accept positional/);
  assert.throws(() => extract(["network", "--selector", "#a"]), /unknown option/);
  assert.throws(() => extract(["console", "--url-contains", "x"]), /unknown option/);
});

test("tabs subcommand validates action, target and URL", async () => {
  const { parseTabsArgs } = await import("../../dist/bin/cli/commands/tabs.js");
  const tabs = (tokens: string[]) => {
    const parsed = parseCliArgs(tokens);
    return parseTabsArgs(parsed.positional, parsed.flags);
  };
  assert.deepEqual(tabs([]), { action: "list", tab: null, url: null, borrow: false, force: false });
  assert.equal(tabs(["new", "https://example.com"]).url, "https://example.com");
  assert.deepEqual(tabs(["use", "T1", "--borrow"]), { action: "use", tab: "T1", url: null, borrow: true, force: false });
  assert.equal(tabs(["close", "T1", "--force"]).force, true);
  assert.throws(() => tabs(["new", "file:///etc/passwd"]), /refusing to open/);
  assert.throws(() => tabs(["use"]), /exactly one targetId/);
  assert.throws(() => tabs(["close", "a", "b"]), /at most one targetId/);
  assert.throws(() => tabs(["list", "--bogus"]), /unknown option/);
});

test("snapshot subcommand validates pagination and filters", async () => {
  const { parseSnapshotArgs } = await import("../../dist/bin/cli/commands/snapshot.js");
  const snapshot = (tokens: string[]) => {
    const parsed = parseCliArgs(tokens);
    return parseSnapshotArgs(parsed.positional, parsed.flags);
  };
  assert.deepEqual(snapshot([]), { args: { offset: 0, limit: 400 }, json: false });
  assert.deepEqual(snapshot(["--offset", "400", "--limit", "50", "--role", "button", "--name", "Save", "--frame-id", "f1", "--json"]), {
    args: { offset: 400, limit: 50, role: "button", name: "Save", frameId: "f1" },
    json: true,
  });
  assert.equal(snapshot(["--max-nodes", "10"]).args.limit, 10);
  assert.throws(() => snapshot(["extra"]), /no positional/);
  assert.throws(() => snapshot(["--offset", "-1"]), /zero or greater/);
  assert.throws(() => snapshot(["--offset", "100001"]), /at most 100000/);
  assert.throws(() => snapshot(["--limit", "0"]), /between 1 and 400/);
  assert.throws(() => snapshot(["--limit", "401"]), /between 1 and 400/);
  assert.throws(() => snapshot(["--limit", "10", "--max-nodes", "20"]), /cannot use both/);
  assert.throws(() => snapshot(["--bogus"]), /unknown option/);
  assert.throws(() => snapshot(["--role", ""]), /must not be empty/);
});

test("snapshot renderer keeps text separate from JSON metadata", async () => {
  const { renderSnapshotResult } = await import("../../dist/bin/cli/commands/snapshot-render.js");
  const result = { targetId: "T1", snapshotVersion: 2, nodes: 1, total: 1, offset: 0, limit: 1, text: "e1 button \"Save\"" };
  assert.equal(renderSnapshotResult(result, false), "e1 button \"Save\"");
  const parsed = JSON.parse(renderSnapshotResult(result, true));
  assert.equal(parsed.targetId, "T1");
  assert.equal(parsed.text, undefined);
});

test("upload/download subcommands validate targets and paths", async () => {
  const { parseUploadArgs } = await import("../../dist/bin/cli/commands/upload.js");
  const { parseDownloadArgs } = await import("../../dist/bin/cli/commands/download.js");
  const upload = (tokens: string[]) => {
    const parsed = parseCliArgs(tokens);
    return parseUploadArgs(parsed.positional, parsed.flags);
  };
  const download = (tokens: string[]) => {
    const parsed = parseCliArgs(tokens);
    return parseDownloadArgs(parsed.positional, parsed.flags);
  };
  assert.deepEqual(upload(["--selector", "#file", "--path", "resume.txt"]), { ref: undefined, selector: "#file", paths: ["resume.txt"] });
  assert.deepEqual(upload(["--ref", "e1", "--paths", "a.txt,b.txt"]), { ref: "e1", selector: undefined, paths: ["a.txt", "b.txt"] });
  assert.throws(() => upload(["--selector", "#file"]), /needs a non-empty --path/);
  assert.throws(() => upload(["--selector", "#file", "--ref", "e1", "--path", "a"]), /not both/);
  assert.throws(() => upload(["extra"]), /no positional/);
  assert.deepEqual(download(["--selector", "#dl"]), { ref: undefined, selector: "#dl", timeoutMs: undefined });
  assert.throws(() => download([]), /needs --ref or --selector/);
  assert.throws(() => download(["--selector", "#dl", "--timeout-ms", "0"]), /between 1 and 120000/);
});

test("snapshot pagination and filter modules validate independently", async () => {
  const { parseSnapshotPagination } = await import("../../dist/bin/cli/commands/snapshot-pagination.js");
  const { parseSnapshotFilters } = await import("../../dist/bin/cli/commands/snapshot-filters.js");
  assert.deepEqual(parseSnapshotPagination({}), { offset: 0, limit: 400 });
  assert.deepEqual(parseSnapshotPagination({ offset: "400", limit: "50" }), { offset: 400, limit: 50 });
  assert.deepEqual(parseSnapshotFilters({ role: "button", name: "Save", "frame-id": "f1" }), { role: "button", name: "Save", frameId: "f1" });
  assert.throws(() => parseSnapshotPagination({ offset: "100001" }), /at most 100000/);
  assert.throws(() => parseSnapshotPagination({ limit: "0" }), /between 1 and 400/);
  assert.throws(() => parseSnapshotFilters({ role: "" }), /must not be empty/);
});

test("wait subcommand validates per-mode flags and timeouts", async () => {
  const { parseWaitArgs } = await import("../../dist/bin/cli/commands/wait.js");
  const wait = (tokens: string[]) => {
    const parsed = parseCliArgs(tokens);
    return parseWaitArgs(parsed.positional, parsed.flags);
  };
  assert.deepEqual(wait(["selector", "--selector", "#name", "--visible", "--timeout-ms", "5000"]), { mode: "selector", selector: "#name", visible: true, timeoutMs: 5000 });
  assert.equal(wait(["text", "--text", "Saved"]).text, "Saved");
  assert.equal(wait(["response", "--url", "/api", "--include-body"]).includeBody, true);
  assert.equal(wait(["delay", "--delay-ms", "10"]).delayMs, 10);
  assert.throws(() => wait([]), /needs one of/);
  assert.throws(() => wait(["selector"]), /needs --selector/);
  assert.throws(() => wait(["text"]), /needs --text/);
  assert.throws(() => wait(["selector_hidden", "--selector", "#x", "--visible"]), /unknown option/);
  assert.throws(() => wait(["delay", "--timeout-ms", "99"]), /between 100 and 120000/);
  assert.throws(() => wait(["text", "--text", "x", "extra"]), /mode and flags only/);
});

test("task subcommand validates action and cleanup policy", async () => {
  const { parseTaskArgs } = await import("../../dist/bin/cli/commands/task.js");
  const task = (tokens: string[]) => {
    const parsed = parseCliArgs(tokens);
    return parseTaskArgs(parsed.positional, parsed.flags);
  };
  assert.deepEqual(task([]), { action: "status" });
  assert.deepEqual(task(["close", "--cleanup", "leave"]), { action: "close", cleanup: "leave" });
  assert.throws(() => task(["bogus"]), /needs one of/);
  assert.throws(() => task(["status", "--cleanup", "leave"]), /unknown option/);
  assert.throws(() => task(["close", "--cleanup", "wat"]), /close-owned or leave/);
  assert.throws(() => task(["status", "extra"]), /one action only/);
});
