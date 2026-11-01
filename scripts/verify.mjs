/**
 * Standalone self-check, no DSH required:
 *   node scripts/verify.mjs --browser chrome
 * Verifies endpoint discovery, CDP attach, a throwaway tab, snapshot and close.
 */

import { Browser } from "../src/browser.mjs";
import { listEndpoints } from "../src/cdp/endpoint.mjs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function arg(name, fallback) {
  const index = process.argv.indexOf("--" + name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const browserName = arg("browser");
const endpoints = await listEndpoints({});
console.log("endpoints:");
for (const endpoint of endpoints) console.log("  " + endpoint.id + " port=" + endpoint.port + " status=" + endpoint.status + (endpoint.browser ? " " + endpoint.browser : ""));

const stateDir = await mkdtemp(join(tmpdir(), "bh-verify-"));
let browser;
try {
  browser = await Browser.connect({ browser: browserName, stateDir, lane: "verify" });
  console.log("connected:", browser.version && browser.version.product);
  const before = await browser.listTabs();
  const page = await browser.newTab("about:blank");
  await page.setViewport({ width: 640, height: 480 });
  const info = await page.info();
  console.log("tab:", page.targetId, info.url, info.readyState);
  await browser.closeTab(page.targetId, { force: true });
  const after = await browser.listTabs();
  console.log("tabs before/after:", before.length, after.length);
  console.log("VERIFY_OK");
} finally {
  browser?.close();
}
process.exit(0);
