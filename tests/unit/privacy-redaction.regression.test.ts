import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { createTools, redactHeadersForOutput, redactUrlForOutput } from "../../dist/lib/tools.js";
import { Browser, sanitizeUrlForState } from "../../dist/src/browser.js";
import { statePath } from "../../dist/src/state.js";
import { FakeTransport } from "./helpers/fake-transport.js";

// Synthetic values contain none of token/secret/session/password: otherwise
// the old value-content heuristic can conceal the key-name defect.
const VALUE_A = "F7k2Q9m4Z6p8";
const VALUE_B = "H3v8D2n5R7c9";
const ORIGIN = "https://fixture.invalid";

function assertAbsent(value: unknown, sentinels: string[], context: string) {
  const serialized = JSON.stringify(value);
  assert.equal(typeof serialized, "string", context + ": expected serializable output");
  for (const sentinel of sentinels) {
    assert.ok(!serialized.includes(sentinel), context + ": synthetic credential remains");
    assert.ok(!serialized.includes(encodeURIComponent(sentinel)), context + ": encoded credential remains");
  }
}

function toolSurface(pageUrl: string, overrides: any = {}) {
  const page = {
    targetId: "fixture-page",
    info: async () => ({ url: pageUrl, title: "Fixture", readyState: "complete" }),
    snapshot: async () => ({ nodes: [], truncated: false }),
  };
  const current = { targetId: page.targetId, url: pageUrl, title: "Fixture" };
  const manager = {
    status: async () => ({ connected: true, tabs: [current], current, endpoints: [] }),
    listTabs: async () => ({ tabs: [current], current }),
    pageFor: async () => page,
    navigate: async () => page,
    useTab: async () => page,
    openTab: async () => page,
    ...overrides,
  };
  const definitions = createTools({}, manager, {}, (definition: any) => definition);
  return (name: string) => {
    const found = definitions.find((definition: any) => definition.name === name);
    assert.ok(found, "missing tool: " + name);
    return found;
  };
}

for (const key of ["accessToken", "AccessToken", "access-token", "ACCESS_TOKEN", "refreshToken", "idToken", "apiKey", "session-id"]) {
  test("R1 query credential key: " + key, () => {
    const input = new URL("/callback?page=2&sort=name", ORIGIN);
    input.searchParams.append(key, VALUE_A);
    const output = redactUrlForOutput(input.toString());
    assertAbsent(output, [VALUE_A], key);
    const url = new URL(output);
    assert.equal(url.origin, ORIGIN);
    assert.equal(url.pathname, "/callback");
    assert.equal(url.searchParams.get("page"), "2");
    assert.equal(url.searchParams.get("sort"), "name");
  });
}

test("R1 encoded key and repeated credentials are all sanitized", () => {
  const output = redactUrlForOutput(ORIGIN + "/?%61ccessToken=" + VALUE_A + "&accessToken=" + VALUE_B + "&page=1&page=2");
  assertAbsent(output, [VALUE_A, VALUE_B], "encoded/repeated query keys");
  assert.deepEqual(new URL(output).searchParams.getAll("page"), ["1", "2"]);
});

test("R1 benign similarly named keys remain intact; redaction is idempotent", () => {
  const benign = ORIGIN + "/?page=2&monkey=capuchin&tokenizer=bpe&apiVersion=v1";
  assert.equal(redactUrlForOutput(benign), benign);
  const first = redactUrlForOutput(ORIGIN + "/?access_token=" + VALUE_A + "&page=2");
  assert.equal(redactUrlForOutput(first), first);
});

const pageUrlCases: Array<[string, string, any, (value: any) => string[]]> = [
  ["status", "browser_status", {}, value => [value.current.url, value.tabs[0].url]],
  ["tabs list", "browser_tabs", { action: "list" }, value => [value.current.url, value.tabs[0].url]],
  ["navigate", "browser_navigate", { url: ORIGIN }, value => [value.url]],
  ["snapshot", "browser_snapshot", {}, value => [value.url]],
  ["tabs use", "browser_tabs", { action: "use", targetId: "fixture-page" }, value => [value.url]],
  ["tabs new", "browser_tabs", { action: "new", url: ORIGIN }, value => [value.url]],
];
for (const [label, toolName, args, urls] of pageUrlCases) {
  test("R1 public tool output and renderer: " + label, async () => {
    const getTool = toolSurface(ORIGIN + "/account?accessToken=" + VALUE_A + "&page=2");
    const tool = getTool(toolName);
    const result = await tool.execute(args, {});
    assertAbsent(result, [VALUE_A], label);
    assertAbsent(tool.output.render(args, result), [VALUE_A], label + " renderer");
    for (const url of urls(result)) assert.equal(new URL(url).searchParams.get("page"), "2");
  });
}

// Entire URL-header redaction and safe URL reconstruction are both acceptable.
// Tests do not prescribe an exact redaction marker or helper implementation.
const redirectCases: Array<[string, string]> = [
  ["Location", ORIGIN + "/callback?access_token=" + VALUE_A],
  ["location", "/callback?code=" + VALUE_A],
  ["lOcAtIoN", "//fixture.invalid/callback?access_token=" + VALUE_A],
  ["Content-Location", ORIGIN + "/result?accessToken=" + VALUE_A],
  ["cOnTeNt-LoCaTiOn", "../callback#access_token=" + VALUE_A],
  ["Location", "https://[invalid]/callback?access_token=" + VALUE_A],
];
for (const [index, [name, value]] of redirectCases.entries()) {
  test("R2 URL response header case " + (index + 1) + ": " + name, () => {
    const input = Object.freeze({ [name]: value, "Content-Type": "application/json", "Cache-Control": "no-store" });
    const output = redactHeadersForOutput(input);
    assertAbsent(output, [VALUE_A], name);
    assert.equal(output["Content-Type"], "application/json");
    assert.equal(output["Cache-Control"], "no-store");
    assert.equal(input[name], value, "do not mutate the captured source headers");
  });
}

for (const includeBody of [false, true]) {
  test("R2 browser_extract network sanitizes headers, includeBody=" + includeBody, async () => {
    const headers = Object.freeze({ Location: ORIGIN + "/callback?access_token=" + VALUE_A, "Content-Type": "application/json" });
    const event = Object.freeze({ requestId: "fixture-request", url: ORIGIN + "/api?page=2", status: 302, headers });
    const page = {
      networkEnabled: true,
      networkEvents: () => [event],
      networkBodies: async (events: any[]) => events.map(item => ({ ...item, body: '{"count":1}' })),
    };
    const tool = toolSurface(ORIGIN, { pageFor: async () => page })("browser_extract");
    const args = { mode: "network", includeBody };
    const result = await tool.execute(args, {});
    assertAbsent(result, [VALUE_A], "network result");
    assertAbsent(tool.output.render(args, result), [VALUE_A], "network renderer");
    assert.equal(result.events[0].status, 302);
    assert.equal(result.events[0].headers["Content-Type"], "application/json");
    assert.equal(new URL(result.events[0].url).searchParams.get("page"), "2");
    assert.equal(headers.Location, ORIGIN + "/callback?access_token=" + VALUE_A);
    if (includeBody) assert.equal(result.events[0].body, '{"count":1}');
  });
}

test("R2 existing sensitive-header protection and safe metadata survive", () => {
  const input = Object.freeze({ Authorization: "Bearer " + VALUE_A, "Set-Cookie": "id=" + VALUE_B, "Content-Type": "text/html", ETag: '"fixture-etag"' });
  const output = redactHeadersForOutput(input);
  assertAbsent(output, [VALUE_A, VALUE_B], "existing header protection");
  assert.equal(output["Content-Type"], "text/html");
  assert.equal(output.ETag, '"fixture-etag"');
});

for (const [label, userinfo] of [
  ["username and password", VALUE_A + ":" + VALUE_B],
  ["username only", VALUE_A],
  ["encoded userinfo", "%46" + VALUE_A.slice(1) + ":%48" + VALUE_B.slice(1)],
]) {
  test("R3 state URL strips " + label, () => {
    const output = sanitizeUrlForState("https://" + userinfo + "@fixture.invalid:8443/path?code=J2k4N6m8#L1p3R5s7");
    const parsed = new URL(output);
    assert.equal(parsed.username, "");
    assert.equal(parsed.password, "");
    assert.equal(parsed.search, "");
    assert.equal(parsed.hash, "");
    assert.equal(output, "https://fixture.invalid:8443/path");
    assertAbsent(output, [VALUE_A, VALUE_B, "J2k4N6m8", "L1p3R5s7"], label);
  });
}

test("R3 benign URLs and about:blank keep their intended identity", () => {
  assert.equal(sanitizeUrlForState(ORIGIN + "/path"), ORIGIN + "/path");
  assert.equal(sanitizeUrlForState("about:blank"), "about:blank");
  const once = sanitizeUrlForState(ORIGIN + "/path?code=" + VALUE_A + "#fragment");
  assert.equal(sanitizeUrlForState(once), once);
});

test("R3 Browser.use persists a credential-free state JSON", async t => {
  const base = await realpath(tmpdir());
  const directory = await mkdtemp(join(base, "bh-redaction-regression-"));
  t.after(async () => {
    const actual = await realpath(directory);
    const child = relative(base, actual);
    assert.ok(child.startsWith("bh-redaction-regression-") && !isAbsolute(child) && !child.includes(sep), "cleanup must stay inside the generated test directory");
    await rm(actual, { recursive: true, force: true });
  });
  const url = "https://" + VALUE_A + ":" + VALUE_B + "@fixture.invalid/account?code=J2k4N6m8#L1p3R5s7";
  const transport = new FakeTransport();
  transport.on("Target.getTargets", () => ({ targetInfos: [{ targetId: "fixture-page", type: "page", url, title: "Fixture" }] }));
  transport.on("Target.attachToTarget", () => ({ sessionId: "fixture-session" }));
  transport.on("Runtime.evaluate", () => ({ result: { value: { url, title: "Fixture" } } }));
  const browser = new Browser({ transport, endpoint: { wsUrl: "ws://fake", source: "unit" }, config: { stateDir: directory, tabGroups: false, marker: false, focusEmulation: false } });
  t.after(async () => { await browser.close(); });
  await browser.use("fixture-page", { lane: "privacy" });
  const raw = await readFile(statePath("privacy", directory), "utf8");
  const state = JSON.parse(raw);
  assert.equal(state.current.targetId, "fixture-page");
  assert.equal(state.current.url, ORIGIN + "/account");
  assertAbsent(raw, [VALUE_A, VALUE_B, "J2k4N6m8", "L1p3R5s7"], "persisted state JSON");
});
