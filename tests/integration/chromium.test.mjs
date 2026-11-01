/**
 * Chromium compatibility: drive the tool layer against a non-default
 * Chromium-based browser (Edge/Brave/Chromium/Vivaldi/Opera) over cdpUrl.
 *
 * Skipped when only one Chromium-family browser is installed (CI runners often
 * have Chrome only); the rest of the suite still runs.
 */

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFixtureServer } from "../../fixtures/server.mjs";
import { findAlternateChromium, launchChrome } from "./helpers/launch-chrome.mjs";
import { BrowserManager } from "../../lib/manager.js";
import { createTools } from "../../lib/tools.js";

const SESSION = "it-alternate-browser";
let server;
let browser;
let manager;
let tools;
let alternate;

before(async () => {
  server = await startFixtureServer();
  alternate = findAlternateChromium();
  if (!alternate) return;
  browser = await launchChrome({ executable: alternate.path });
  const stateDir = await mkdtemp(join(tmpdir(), "bh-alt-"));
  manager = new BrowserManager({ cdpUrl: browser.httpUrl, stateDir });
  tools = createTools(
    { tools: { register() { throw new Error("createTools must not register by itself"); } }, effect() {}, get() { return undefined; } },
    manager,
    { maxSnapshotNodes: 250 },
    (definition) => definition,
  );
});

after(async () => {
  try { await manager?.close(); } catch { /* ignore */ }
  await browser?.close();
  await server?.close();
});

function tool(name) {
  const found = (tools || []).find((definition) => definition.name === name);
  assert.ok(found, name + " is registered");
  return found;
}

function run(name, args) {
  return tool(name).execute(args, { agent: { session: { id: SESSION } } });
}

test("T11 any Chromium browser works through the tool layer", async (t) => {
  if (!browser) {
    t.skip("no alternate Chromium browser installed (Edge/Brave/Chromium/Vivaldi/Opera)");
    return;
  }
  const status = await run("browser_status", {});
  assert.equal(status.connected, true);
  assert.ok(status.version && typeof status.version.product === "string" && status.version.product.length > 0,
    "browser version: " + JSON.stringify(status.version));
  assert.ok(/^(Edg|Brave|Chromium|Vivaldi|OPR|Arc)/i.test(status.version.product),
    "connected to the alternate browser (" + status.version.product + ", " + alternate.label + ")");

  const navigate = await run("browser_navigate", { url: server.url + "/a.html" });
  assert.match(navigate.snapshot, /Page A/);
  const text = await run("browser_extract", { mode: "text", selector: "#a" });
  assert.equal(text.value, "alpha");
  const js = await run("browser_extract", { mode: "js", expression: "document.title" });
  assert.equal(js.value, "Page A");

  const closed = await run("browser_tabs", { action: "close", targetId: navigate.targetId });
  assert.equal(closed.ok, true);
});
