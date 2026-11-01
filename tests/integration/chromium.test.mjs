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
import { startFixtureServer } from "../fixtures/server.mjs";
import { findAlternateChromium, launchChrome } from "./helpers/launch-chrome.mjs";
import { BrowserManager } from "../../dist/lib/manager.js";
import { createTools } from "../../dist/lib/tools.js";

const SESSION = "it-alternate-browser";
let server;
let browser;
let manager;
let tools;
let alternate;
let launchError = null;

before(async () => {
  server = await startFixtureServer();
  alternate = findAlternateChromium();
  if (!alternate) return;
  try {
    browser = await launchChrome({ executable: alternate.path });
  } catch (error) {
    launchError = error;
    browser = null;
    return;
  }
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
    t.skip(launchError
      ? "alternate Chromium (" + (alternate && alternate.label) + ") could not be launched: " + String(launchError.message).slice(0, 160)
      : "no alternate Chromium browser installed (Edge/Brave/Chromium/Vivaldi/Opera)");
    return;
  }
  // The browser may still be starting up in slower CI environments.
  let status = await run("browser_status", {});
  const deadline = Date.now() + 10_000;
  while (!status.connected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    status = await run("browser_status", {});
  }
  if (!status.connected) {
    const reason = "alternate Chromium (" + alternate.label + ") did not answer over cdpUrl: " + String(status.error || "").slice(0, 160);
    if (process.env.CI) {
      t.skip(reason + " (CI sandbox)");
      return;
    }
    assert.equal(status.connected, true, reason);
  }
  assert.ok(status.version && typeof status.version.product === "string" && status.version.product.length > 0,
    "browser version: " + JSON.stringify(status.version));
  assert.ok(/Edg|Brave|Chromium|Vivaldi|OPR|Arc/i.test(status.version.product),
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
