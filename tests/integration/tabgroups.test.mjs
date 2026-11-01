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
import { startFixtureServer } from "../fixtures/server.mjs";
import { launchChrome } from "./helpers/launch-chrome.mjs";
import { Browser } from "../../src/browser.mjs";
import { tabGroupTitleFor } from "../../src/tabgroups.mjs";

let server;

before(async () => {
  server = await startFixtureServer();
});

after(async () => {
  await server?.close();
});

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
  const stateDir = await mkdtemp(join(tmpdir(), "bh-groups-headless-"));
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
  const stateDir = await mkdtemp(join(tmpdir(), "bh-groups-headful-"));
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
    const work = await browser.transport.send("Target.createTarget", { url: server.url + "/b.html", background: true }, { timeoutMs: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const stillGrouped = await browser.tabGroups.evaluate(
      "chrome.tabs.query({ groupId: " + Number(group.id) + " }).then((tabs) => tabs.length)",
    );
    assert.equal(stillGrouped, 2, "work tab was not added to the harness group");
    try { await browser.transport.send("Target.closeTarget", { targetId: work.targetId }, { timeoutMs: 5_000 }); } catch { /* ignore */ }

    const stored = await import("../../src/state.mjs").then((state) => state.readState(lane, stateDir));
    assert.equal(stored.group.id, group.id, "group id is persisted for later tasks");

    await browser.closeTab(first.targetId, { force: true });
    await browser.closeTab(second.targetId, { force: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const remaining = await browser.tabGroups.listGroups();
    assert.ok(!remaining.some((entry) => entry.id === group.id), "empty task group disappears");
  } finally {
    await browser.close();
    await chrome.close();
  }
});
