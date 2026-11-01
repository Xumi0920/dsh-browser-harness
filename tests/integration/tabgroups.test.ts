/**
 * Per-task Chrome tab groups for harness-created tabs.
 *
 * Tab groups need a headful browser (the bundled MV3 extension's worker does
 * not start in headless Chrome). Linux runs the headful scenario under xvfb in
 * CI and skips it when no display is available; the headless test still checks
 * that the bridge degrades gracefully and never breaks tab creation.
 */

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFixtureServer } from "../fixtures/server.js";
import { launchChrome } from "./helpers/launch-chrome.js";
import { Browser } from "../../dist/src/browser.js";
import { tabGroupTitleFor } from "../../dist/src/tabgroups.js";

let server;

before(async () => {
  server = await startFixtureServer();
});

after(async () => {
  await server?.close();
});
import { cleanupTempDirs, tempDir } from "../helpers/temp.js";


after(cleanupTempDirs);

async function waitUntil(check, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return last;
}

function canRunHeadful() {
  // Windows/macOS have a window server; Linux needs an X/Wayland display
  // (CI provides one through xvfb-run).
  if (process.platform === "win32" || process.platform === "darwin") return true;
  return Boolean(process.env.DISPLAY);
}

test("S15 headless browsers still create tabs when tab groups are unavailable", async (t) => {
  const chrome = await launchChrome().catch(() => null);
  if (!chrome) {
    t.skip("no Chromium browser available");
    return;
  }
  const stateDir = await tempDir("bh-groups-headless-");
  const browser = await Browser.connect({ cdpUrl: chrome.httpUrl, stateDir, lane: "dsh-headless-groups" });
  try {
    const started = Date.now();
    const page = await browser.newTab(server.url + "/a.html");
    const elapsed = Date.now() - started;
    assert.equal(page.targetId.length > 0, true);
    assert.equal(elapsed < 15_000, true, "tab creation stays fast even when grouping is unavailable");
    const info = browser.tabGroups.info();
    assert.equal(info.enabled, true);
    assert.equal(typeof info.extensionPath, "string");
    await browser.closeTab(page.targetId, { force: true });
  } finally {
    await browser.close();
    await chrome.close();
  }
});

test("S16 harness tabs are grouped per task and work tabs are left alone", async (t) => {
  if (!canRunHeadful()) {
    t.skip("tab groups need a headful Chromium browser (skipped in CI / headless environments)");
    return;
  }
  const chrome = await launchChrome({
    headless: false,
    allowExtensions: true,
    extraArgs: ["--window-position=-3000,-3000", "--window-size=900,600"],
  }).catch(() => null);
  if (!chrome) {
    t.skip("no Chromium browser available");
    return;
  }
  const stateDir = await tempDir("bh-groups-headful-");
  const lane = "dsh-grouptask";
  const browser = await Browser.connect({ cdpUrl: chrome.httpUrl, stateDir, lane });
  try {
    const first = await browser.newTab(server.url + "/a.html");
    const second = await browser.newTab(server.url + "/b.html");
    const info = browser.tabGroups.info();
    assert.equal(info.available, true, "tab-group bridge is ready (error: " + info.error + ")");
    const groups = await browser.tabGroups.listGroups();
    const group = groups.find((entry) => entry.title === tabGroupTitleFor(lane));
    assert.ok(group, "task group exists: " + JSON.stringify(groups));
    const grouped = await browser.tabGroups.evaluate(
      "chrome.tabs.query({ groupId: " + Number(group.id) + " }).then((tabs) => tabs.map((tab) => ({ id: tab.id, url: tab.url })))",
    );
    assert.equal(grouped.length, 2, "both harness tabs are in the group");

    // A tab the harness did not create must stay out of the group.
    const groupCount = () => browser.tabGroups.evaluate(
      "chrome.tabs.query({ groupId: " + Number(group.id) + " }).then((tabs) => tabs.length)",
    );
    const work = await browser.transport.send("Target.createTarget", { url: server.url + "/b.html", background: true }, { timeoutMs: 5_000 });
    assert.equal(await groupCount(), 2, "both harness tabs are grouped");
    const stableUntil = Date.now() + 1_000;
    while (Date.now() < stableUntil) {
      assert.equal(await groupCount(), 2, "work tab was not added to the harness group");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    try { await browser.transport.send("Target.closeTarget", { targetId: work.targetId }, { timeoutMs: 5_000 }); } catch { /* ignore */ }

    const stored = await import("../../dist/src/state.js").then((state) => state.readState(lane, stateDir));
    assert.equal(stored.group.id, group.id, "group id is persisted for later tasks");

    await browser.closeTab(first.targetId, { force: true });
    await browser.closeTab(second.targetId, { force: true });
    const remaining = await waitUntil(
      () => browser.tabGroups.listGroups(),
      (groups) => Array.isArray(groups) && !groups.some((entry) => entry.id === group.id),
    );
    assert.ok(!remaining.some((entry) => entry.id === group.id), "empty task group disappears");
  } finally {
    await browser.close();
    await chrome.close();
  }
});
