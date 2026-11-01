/**
 * Tool-layer scenarios: drive lib/tools.js + lib/manager.js against a real
 * throwaway Chrome. These cover the model-facing surface directly (the unit
 * tests stub the manager), including network capture across tool calls.
 */

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFixtureServer } from "../../fixtures/server.mjs";
import { launchChrome } from "./helpers/launch-chrome.mjs";
import { BrowserManager } from "../../lib/manager.js";
import { createTools } from "../../lib/tools.js";

const SESSION = "it-tools-session";
let server;
let chrome;
let manager;
let tools;

before(async () => {
  server = await startFixtureServer();
  const stateDir = await mkdtemp(join(tmpdir(), "bh-tools-"));
  chrome = await launchChrome();
  if (chrome) {
    manager = new BrowserManager({ cdpUrl: chrome.httpUrl, stateDir });
    tools = createTools(
      { tools: { register() { throw new Error("createTools must not register by itself"); } }, effect() {}, get() { return undefined; } },
      manager,
      { maxSnapshotNodes: 250 },
      (definition) => definition,
    );
  }
});

after(async () => {
  try { await manager?.close(); } catch { /* ignore */ }
  await chrome?.close();
  await server?.close();
});

function needChrome(t) {
  if (!manager) {
    t.skip("no Chrome/Edge executable found (set CHROME_PATH to run tool scenarios)");
    return true;
  }
  return false;
}

function tool(name) {
  const found = (tools || []).find((definition) => definition.name === name);
  assert.ok(found, name + " is registered");
  return found;
}

function run(name, args) {
  return tool(name).execute(args, { agent: { session: { id: SESSION } } });
}

async function waitForText(expected, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await run("browser_extract", { mode: "text" });
    if (String(value.value).includes(expected)) return String(value.value);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("page text never contained: " + expected);
}

test("T01 browser_status exposes a connected endpoint", async (t) => {
  if (needChrome(t)) return;
  const status = await run("browser_status", {});
  assert.equal(status.connected, true);
  assert.ok(Array.isArray(status.endpoints) && status.endpoints.length > 0);
  assert.ok(status.version && status.version.product, "browser version is reported");
});

test("T02 navigate returns snapshot refs and a click works by ref", async (t) => {
  if (needChrome(t)) return;
  const nav = await run("browser_navigate", { url: server.url + "/net.html", newTab: true });
  assert.match(nav.url, /net\.html/);
  assert.match(nav.snapshot, /e\d+ button "Load"/);
  assert.equal(nav.truncated, false);
  const ref = /(e\d+) button "Load"/.exec(nav.snapshot)[1];
  const act = await run("browser_act", { action: "click", ref });
  assert.equal(act.ok, true);
  const text = await waitForText("loaded:42");
  assert.match(text, /loaded:42/);
  const tabs = await run("browser_tabs", { action: "list" });
  const current = tabs.tabs.find((tab) => tab.targetId === nav.targetId);
  assert.ok(current, "created tab is listed");
  assert.equal(current.owned, true, "harness-created tab is marked owned");
  assert.equal((await run("browser_tabs", { action: "close", targetId: nav.targetId })).ok, true);
  const afterTabs = await run("browser_tabs", { action: "list" });
  assert.ok(!afterTabs.tabs.some((tab) => tab.targetId === nav.targetId));
});

test("T03 browser_extract network sees requests captured across tool calls", async (t) => {
  if (needChrome(t)) return;
  const nav = await run("browser_navigate", { url: server.url + "/net.html", newTab: true });
  const ref = /(e\d+) button "Load"/.exec(nav.snapshot)[1];
  await run("browser_act", { action: "click", ref });
  await waitForText("loaded:42");
  const network = await run("browser_extract", { mode: "network", urlContains: "/api/slow" });
  assert.equal(network.capturing, true, "tool-enabled capture is active");
  assert.ok(network.events.length >= 1, "network events survive between tool calls");
  const entry = network.events.find((event) => String(event.url).includes("/api/slow"));
  assert.ok(entry, "the fetch is captured");
  assert.equal(entry.status, 200);
  const withBody = await run("browser_extract", { mode: "network", urlContains: "/api/slow", includeBody: true });
  const bodyEntry = withBody.events.find((event) => String(event.url).includes("/api/slow"));
  assert.match(String(bodyEntry.body), /"value":42/);
  await run("browser_tabs", { action: "close", targetId: nav.targetId });
});

test("T04 stale refs fail with an actionable error instead of remapping", async (t) => {
  if (needChrome(t)) return;
  const nav = await run("browser_navigate", { url: server.url + "/a.html", newTab: true });
  const ref = /^(e\d+)/m.exec(nav.snapshot)[1];
  await run("browser_navigate", { url: server.url + "/b.html" });
  await assert.rejects(run("browser_act", { action: "click", ref }), /E_ELEMENT_NOT_FOUND/);
  await run("browser_tabs", { action: "close", targetId: nav.targetId });
});

test("T05 browser_screenshot writes a PNG through the tool", async (t) => {
  if (needChrome(t)) return;
  const nav = await run("browser_navigate", { url: server.url + "/colors.html", newTab: true });
  const shot = await run("browser_screenshot", {});
  assert.match(shot.path, /\.png$/);
  assert.ok(shot.bytes > 1_000);
  await run("browser_tabs", { action: "close", targetId: nav.targetId });
});
