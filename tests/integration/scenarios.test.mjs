/**
 * End-to-end scenario tests: real headless Chrome + the local fixture server.
 *
 * These are the acceptance tests for the harness. They never touch the user's
 * own browser profile: every run launches a throwaway Chrome.
 */

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startFixtureServer } from "../fixtures/server.mjs";
import { launchChrome } from "./helpers/launch-chrome.mjs";
import { Browser } from "../../dist/src/browser.js";
import { findByRole, snapshotToText } from "../../dist/src/ax.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE_UPLOAD = join(HERE, "..", "fixtures", "upload-sample.txt");

let server;
let chrome;
let browser;
let stateDir;
const openedTabs = new Set();

before(async () => {
  server = await startFixtureServer();
  stateDir = await mkdtemp(join(tmpdir(), "bh-state-"));
  chrome = await launchChrome();
  if (chrome) {
    browser = await Browser.connect({ cdpUrl: chrome.httpUrl, stateDir, lane: "integration" });
  }
});

after(async () => {
  for (const targetId of [...openedTabs]) {
    try { await browser.closeTab(targetId, { force: true }); } catch { /* ignore */ }
  }
  try { await browser?.close(); } catch { /* ignore */ }
  await chrome?.close();
  await server?.close();
});

function needChrome(t) {
  if (!browser) {
    t.skip("no Chrome/Edge executable found (set CHROME_PATH to run integration tests)");
    return true;
  }
  return false;
}

async function openTab(t, pathname) {
  if (needChrome(t)) return null;
  const page = await browser.newTab(server.url + pathname);
  openedTabs.add(page.targetId);
  return page;
}

test("S01 login: fill, submit, session persists across reload, logout", async (t) => {
  const page = await openTab(t, "/login");
  if (!page) return;
  await page.fill({ selector: "#user", text: "demo" });
  await page.fill({ selector: "#pass", text: "demo" });

  // click through a snapshot ref, proving AX refs work end to end
  const snapshot = await page.snapshot();
  const submit = findByRole(snapshot.nodes, { role: "button", name: "Sign in" });
  assert.ok(submit.length >= 1, "snapshot exposes the submit button");
  await page.click({ ref: submit[0].ref });

  await page.waitForFunction("location.pathname === '/dashboard'", { timeoutMs: 10_000 });
  assert.match(await page.text("#status"), /signed in as demo/);

  await page.navigate(server.url + "/dashboard");
  assert.match(await page.text("#status"), /signed in as demo/, "session cookie survives a reload");

  await page.click({ selector: "#logout" });
  await page.waitForFunction("location.pathname === '/login'", { timeoutMs: 10_000 });
  await browser.closeTab(page.targetId, { force: true });
  openedTabs.delete(page.targetId);
});

test("S02 async render: wait for JS-built rows and extract them", async (t) => {
  const page = await openTab(t, "/async");
  if (!page) return;
  await page.waitForSelector("li[data-row]", { timeoutMs: 10_000 });
  const rows = await page.evaluate(() => [...document.querySelectorAll("li[data-row]")].map((row) => row.textContent));
  assert.deepEqual(rows, ["first", "second", "third", "fourth", "fifth"]);
  const snapshot = await page.snapshot();
  const listItems = snapshot.nodes.filter((node) => node.role === "listitem");
  assert.ok(listItems.length >= 5, "snapshot exposes the rendered rows");
  assert.match(snapshotToText(snapshot), /Async list/);
  await browser.closeTab(page.targetId, { force: true });
  openedTabs.delete(page.targetId);
});

test("S03 tabs: create two, switch by id, close only our own", async (t) => {
  if (needChrome(t)) return;
  const pageA = await browser.newTab(server.url + "/a.html");
  const pageB = await browser.newTab(server.url + "/b.html");
  openedTabs.add(pageA.targetId);
  openedTabs.add(pageB.targetId);
  const tabs = await browser.listTabs();
  assert.ok(tabs.some((tab) => tab.targetId === pageA.targetId));
  const switched = await browser.use(pageA.targetId);
  assert.match((await switched.info()).title, /Page A/);
  await browser.closeTab(pageB.targetId, { force: true });
  openedTabs.delete(pageB.targetId);
  const afterTabs = await browser.listTabs();
  assert.ok(!afterTabs.some((tab) => tab.targetId === pageB.targetId));
  await browser.closeTab(pageA.targetId, { force: true });
  openedTabs.delete(pageA.targetId);
});

test("S04 iframe: frames() exposes the child and in-frame evaluation clicks it", async (t) => {
  const page = await openTab(t, "/iframe.html");
  if (!page) return;
  const frames = await page.frames();
  assert.ok(frames.some((frame) => frame.url.includes("iframe-child")), "child frame is listed");
  await page.waitForFunction("document.querySelector('iframe') !== null");
  // Same-origin child frame: evaluate in its execution context.
  const before = await page.evaluateInFrame({ urlContains: "iframe-child" }, "document.getElementById('inner-out').textContent");
  assert.equal(before, "not clicked");
  await page.evaluateInFrame({ urlContains: "iframe-child" }, "document.getElementById('inner').click()");
  const after = await page.evaluateInFrame({ urlContains: "iframe-child" }, "document.getElementById('inner-out').textContent");
  assert.match(after, /clicked/);
  await browser.closeTab(page.targetId, { force: true });
  openedTabs.delete(page.targetId);
});

test("S05 shadow DOM: snapshot finds the deep button and clicks it", async (t) => {
  const page = await openTab(t, "/shadow.html");
  if (!page) return;
  const snapshot = await page.snapshot();
  const buttons = snapshot.nodes.filter((node) => node.role === "button");
  assert.ok(buttons.length >= 1, "snapshot recurses into open shadow roots");
  await page.click({ ref: buttons[0].ref });
  await page.waitForFunction("document.getElementById('out').textContent === 'shadow clicked'", { timeoutMs: 5_000 });
  await browser.closeTab(page.targetId, { force: true });
  openedTabs.delete(page.targetId);
});

test("S06 download: click triggers a finished file with expected content", async (t) => {
  const page = await openTab(t, "/download.html");
  if (!page) return;
  const result = await page.download({
    dir: join(stateDir, "downloads"),
    trigger: () => page.click({ selector: "#dl" }),
    timeoutMs: 20_000,
  });
  assert.equal(result.filename, "report.csv");
  const content = await import("node:fs/promises").then((fs) => fs.readFile(result.path, "utf8"));
  assert.match(content, /alpha/);
  assert.match(content, /beta/);
  await browser.closeTab(page.targetId, { force: true });
  openedTabs.delete(page.targetId);
});

test("S07 upload: visible and hidden file inputs both receive the file", async (t) => {
  const page = await openTab(t, "/upload.html");
  if (!page) return;
  await page.upload({ selector: "#file" }, SAMPLE_UPLOAD);
  await page.waitForFunction("document.getElementById('result').textContent.startsWith('visible')", { timeoutMs: 5_000 });
  const visible = await page.text("#result");
  assert.match(visible, /visible:upload-sample\.txt/);
  await page.upload({ selector: "#hidden-file" }, SAMPLE_UPLOAD);
  await page.waitForFunction("document.getElementById('result').textContent.startsWith('hidden')", { timeoutMs: 5_000 });
  assert.match(await page.text("#result"), /hidden:upload-sample\.txt/);
  await browser.closeTab(page.targetId, { force: true });
  openedTabs.delete(page.targetId);
});

test("S08 dialogs: auto-dismiss never hangs and is recorded", async (t) => {
  const page = await openTab(t, "/dialog.html");
  if (!page) return;
  await page.click({ selector: "#alert" });
  await page.waitForFunction("document.getElementById('out').textContent === 'ready'", { timeoutMs: 5_000 });
  assert.deepEqual(page.dialogHistory.map((dialog) => dialog.type), ["alert"]);
  await page.click({ selector: "#confirm" });
  await page.waitForFunction("document.getElementById('out').textContent === 'confirm:false'", { timeoutMs: 5_000 });
  assert.equal(page.dialogHistory.length, 2);
  await browser.closeTab(page.targetId, { force: true });
  openedTabs.delete(page.targetId);
});

test("S09 form validation: error visible, fix, submit succeeds", async (t) => {
  const page = await openTab(t, "/form.html");
  if (!page) return;
  await page.click({ selector: "#submit" });
  await page.waitForSelector("#err", { visible: true, timeoutMs: 5_000 });
  assert.match(await page.text("#err"), /required/);
  await page.fill({ selector: "#name", text: "harness" });
  await page.click({ selector: "#submit" });
  await page.waitForSelector("#ok", { visible: true, timeoutMs: 5_000 });
  assert.match(await page.text("#ok"), /submitted:harness/);
  await browser.closeTab(page.targetId, { force: true });
  openedTabs.delete(page.targetId);
});

test("S10 selector timeout: structured E_SELECTOR_TIMEOUT, no hang", async (t) => {
  const page = await openTab(t, "/never.html");
  if (!page) return;
  await assert.rejects(page.waitForSelector("#does-not-exist", { timeoutMs: 300 }), (error) => {
    assert.equal(error.code, "E_SELECTOR_TIMEOUT");
    assert.match(error.message, /does-not-exist/);
    return true;
  });
  await browser.closeTab(page.targetId, { force: true });
  openedTabs.delete(page.targetId);
});

test("S11 stale target: external close is recovered by the next call", async (t) => {
  if (needChrome(t)) return;
  const page = await browser.newTab(server.url + "/a.html");
  openedTabs.add(page.targetId);
  const other = await Browser.connect({ cdpUrl: chrome.httpUrl, stateDir: join(stateDir, "other"), lane: "other" });
  await other.transport.send("Target.closeTarget", { targetId: page.targetId });
  await other.close();
  assert.equal(await browser.current(), null, "closed tab is pruned from state");
  const recovered = await browser.open(server.url + "/b.html");
  assert.match((await recovered.info()).title, /Page B/);
  openedTabs.add(recovered.targetId);
  await browser.closeTab(recovered.targetId, { force: true });
  openedTabs.delete(recovered.targetId);
});

test("S12 screenshots: PNG signature and dimensions follow the viewport", async (t) => {
  const page = await openTab(t, "/colors.html");
  if (!page) return;
  await page.setViewport({ width: 400, height: 300, deviceScaleFactor: 1 });
  const shot = await page.screenshot({ path: join(stateDir, "shot.png") });
  assert.equal(shot.width, 400);
  assert.equal(shot.height, 300);
  assert.ok(shot.bytes > 1_000);
  const png = await import("node:fs/promises").then((fs) => fs.readFile(shot.path));
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  await page.clearViewport();
  await browser.closeTab(page.targetId, { force: true });
  openedTabs.delete(page.targetId);
});

test("S13 network capture: response body is available inside one call", async (t) => {
  const page = await openTab(t, "/net.html");
  if (!page) return;
  await page.startNetworkCapture();
  await page.click({ selector: "#go" });
  const response = await page.waitForResponse("/api/slow", { includeBody: true, timeoutMs: 10_000 });
  assert.equal(response.status, 200);
  assert.match(response.body, /"value":42/);
  assert.ok(page.networkEvents().some((event) => event.url.includes("/api/slow")));
  await page.stopNetworkCapture();
  await browser.closeTab(page.targetId, { force: true });
  openedTabs.delete(page.targetId);
});

test("S14 cookies: redacted by default, value opt-in, clear restores 401", async (t) => {
  const page = await openTab(t, "/login");
  if (!page) return;
  await page.fill({ selector: "#user", text: "demo" });
  await page.fill({ selector: "#pass", text: "demo" });
  await page.click({ selector: "#submit" });
  await page.waitForFunction("location.pathname === '/dashboard'", { timeoutMs: 10_000 });
  const redacted = await page.cookies({ url: server.url });
  const sidEntry = redacted.find((cookie) => cookie.name === "sid");
  assert.ok(sidEntry, "sid cookie exists after login");
  assert.equal(sidEntry.value, undefined, "cookie values are redacted by default");
  const valued = await page.cookies({ url: server.url, includeValues: true });
  assert.ok(valued.find((cookie) => cookie.name === "sid").value.length > 0);
  await page.clearCookies({ all: true });
  await page.navigate(server.url + "/dashboard");
  await page.waitForFunction("location.pathname === '/login'", { timeoutMs: 10_000 });
  await browser.closeTab(page.targetId, { force: true });
  openedTabs.delete(page.targetId);
});
