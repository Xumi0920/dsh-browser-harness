/**
 * Tool-layer scenarios: drive lib/tools.js + lib/manager.js against a real
 * throwaway Chrome. These cover the model-facing surface directly (the unit
 * tests stub the manager), including network capture across tool calls.
 */

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFixtureServer } from "../fixtures/server.js";
import { launchChrome } from "./helpers/launch-chrome.js";
import { BrowserManager } from "../../dist/lib/manager.js";
import { createTools } from "../../dist/lib/tools.js";
import { cleanupTempDirs, tempDir } from "../helpers/temp.js";


after(cleanupTempDirs);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const runCli = promisify(execFile);
const SESSION = "it-tools-session";
let server;
let chrome;
let manager;
let tools;
let stateDir;

before(async () => {
  server = await startFixtureServer();
  stateDir = await tempDir("bh-tools-");
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

function runAs(name, args, sessionId) {
  return tool(name).execute(args, { agent: { session: { id: sessionId } } });
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
  assert.equal(typeof status.tabGroups, "object", "tab group bridge status is reported");
  assert.equal(status.tabGroups.enabled, true);
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

test("T06 browser_snapshot filters by role and reports refs", async (t) => {
  if (needChrome(t)) return;
  const nav = await run("browser_navigate", { url: server.url + "/form.html", newTab: true });
  const snap = await run("browser_snapshot", { role: "button" });
  assert.equal(snap.targetId, nav.targetId);
  assert.ok(snap.nodes >= 1, "form has at least one button");
  assert.match(snap.text, /button/);
  assert.equal(snap.truncated, false);
  const byName = await run("browser_snapshot", { name: "submit" });
  assert.ok(byName.nodes >= 1, "name filter finds the submit button");
  await run("browser_tabs", { action: "close", targetId: nav.targetId });
});

test("T07 browser_act fill, type and press drive real inputs", async (t) => {
  if (needChrome(t)) return;
  const nav = await run("browser_navigate", { url: server.url + "/form.html", newTab: true });
  await run("browser_act", { action: "fill", selector: "#name", text: "harness" });
  const filled = await run("browser_extract", { mode: "js", expression: "document.querySelector('#name').value" });
  assert.equal(filled.value, "harness");
  await run("browser_act", { action: "type", text: "x" });
  const typed = await run("browser_extract", { mode: "js", expression: "document.querySelector('#name').value" });
  assert.equal(typed.value, "harnessx", "type inserts into the focused input");
  const pressed = await run("browser_act", { action: "press", key: "Tab" });
  assert.equal(pressed.ok, true);
  await run("browser_tabs", { action: "close", targetId: nav.targetId });
});

test("T08 browser_extract html, js and text-selector modes", async (t) => {
  if (needChrome(t)) return;
  const nav = await run("browser_navigate", { url: server.url + "/a.html", newTab: true });
  const html = await run("browser_extract", { mode: "html" });
  assert.match(html.value, /Page A/);
  assert.equal(html.truncated, false);
  const js = await run("browser_extract", { mode: "js", expression: "document.title" });
  assert.equal(js.value, "Page A");
  const text = await run("browser_extract", { mode: "text", selector: "#a" });
  assert.equal(text.value, "alpha");
  await run("browser_tabs", { action: "close", targetId: nav.targetId });
});

test("T09 browser_tabs new/use/close manage harness tabs only", async (t) => {
  if (needChrome(t)) return;
  const nav = await run("browser_navigate", { url: server.url + "/a.html", newTab: true });
  const created = await run("browser_tabs", { action: "new", url: server.url + "/b.html" });
  const tabs = await run("browser_tabs", { action: "list" });
  const a = tabs.tabs.find((tab) => tab.targetId === nav.targetId);
  const b = tabs.tabs.find((tab) => tab.targetId === created.created);
  assert.ok(a, "navigate tab is listed");
  assert.ok(b, "new tab is listed");
  assert.equal(a.owned, true);
  assert.equal(b.owned, true);
  const used = await run("browser_tabs", { action: "use", targetId: nav.targetId });
  assert.equal(used.used, nav.targetId);
  assert.match(used.url, /a\.html/);
  await run("browser_tabs", { action: "close", targetId: created.created });
  await run("browser_tabs", { action: "close", targetId: nav.targetId });
  const after = await run("browser_tabs", { action: "list" });
  assert.ok(!after.tabs.some((tab) => tab.targetId === created.created || tab.targetId === nav.targetId));
});

test("T10 CLI open/snapshot/info/close drive a real tab", async (t) => {
  if (needChrome(t)) return;
  const stateDir = await tempDir("bh-cli-");
  const env = { ...process.env, BH_CDP_URL: chrome.httpUrl, BH_STATE_DIR: stateDir };
  const bh = join(ROOT, "dist", "bin", "bh.js");
  const exec = (args) => runCli(process.execPath, [bh, ...args], { env, timeout: 30_000 });

  const opened = await exec(["open", server.url + "/a.html"]);
  assert.match(opened.stdout, /a\.html/);

  const snapshot = await exec(["snapshot"]);
  assert.match(snapshot.stdout, /Page A/);

  const info = await exec(["info"]);
  assert.match(info.stdout, /"url"/);
  assert.match(info.stdout, /a\.html/);

  const groups = await exec(["groups"]);
  const groupsInfo = JSON.parse(groups.stdout);
  assert.equal(groupsInfo.enabled, true);
  assert.ok(Array.isArray(groupsInfo.groups));

  const closed = await exec(["close"]);
  assert.match(closed.stdout, /"ok":\s*true/);

  const doctor = await runCli(process.execPath, [bh, "doctor"], { env, timeout: 30_000 });
  assert.match(doctor.stdout, /chrome/);
});

test("T28 browser_wait supports selector, text, delay and network-idle modes", async (t) => {
  if (needChrome(t)) return;
  const nav = await run("browser_navigate", { url: server.url + "/form.html", newTab: true });
  const selected = await run("browser_wait", { mode: "selector", selector: "#name", visible: true });
  assert.equal(selected.matched, true);
  const text = await run("browser_wait", { mode: "text", text: "Submit" });
  assert.equal(text.matched, true);
  const delayed = await run("browser_wait", { mode: "delay", delayMs: 10 });
  assert.equal(delayed.waitedMs, 10);
  const idle = await run("browser_wait", { mode: "network_idle", timeoutMs: 5_000, idleMs: 100 });
  assert.equal(idle.ok, true);
  await run("browser_tabs", { action: "close", targetId: nav.targetId });
});

test("T29 browser_act hover and browser_extract console work on a real page", async (t) => {
  if (needChrome(t)) return;
  const nav = await run("browser_navigate", { url: server.url + "/form.html", newTab: true });
  const hovered = await run("browser_act", { action: "hover", selector: "#submit" });
  assert.equal(hovered.ok, true);
  const highlighted = await run("browser_act", { action: "highlight", selector: "#submit" });
  assert.equal(highlighted.ok, true);
  await run("browser_extract", { mode: "js", expression: "console.error('console-probe')" });
  await run("browser_wait", { mode: "delay", delayMs: 30 });
  const consoleResult = await run("browser_extract", { mode: "console" });
  assert.ok(consoleResult.events.some((event) => event.text.includes("console-probe")), "console event is captured");
  await run("browser_tabs", { action: "close", targetId: nav.targetId });
});

test("T30 browser_screenshot element clip and browser_pdf write files", async (t) => {
  if (needChrome(t)) return;
  const nav = await run("browser_navigate", { url: server.url + "/form.html", newTab: true });
  const shot = await run("browser_screenshot", { selector: "#name", path: "element.png" });
  const image = await readFile(shot.path);
  assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  const pdf = await run("browser_pdf", { path: "page.pdf" });
  const document = await readFile(pdf.path);
  assert.equal(document.subarray(0, 4).toString(), "%PDF");
  await run("browser_tabs", { action: "close", targetId: nav.targetId });
});

test("T31 browser_upload sets a file input from uploadDir", async (t) => {
  if (needChrome(t)) return;
  const uploadDir = join(stateDir, "uploads");
  await mkdir(uploadDir, { recursive: true });
  await copyFile(fileURLToPath(new URL("../../tests/fixtures/upload-sample.txt", import.meta.url)), join(uploadDir, "resume.txt"));
  const nav = await run("browser_navigate", { url: server.url + "/upload.html", newTab: true });
  const uploaded = await run("browser_upload", { selector: "#file", path: "resume.txt" });
  assert.equal(uploaded.ok, true);
  assert.equal(uploaded.count, 1);
  await run("browser_wait", { mode: "text", text: "visible:resume.txt" });
  await run("browser_tabs", { action: "close", targetId: nav.targetId });
});

test("T32 browser_download clicks a link and returns the downloaded file", async (t) => {
  if (needChrome(t)) return;
  const nav = await run("browser_navigate", { url: server.url + "/download.html", newTab: true });
  const downloaded = await run("browser_download", { selector: "#dl" });
  assert.equal(downloaded.ok, true);
  assert.match(downloaded.filename, /report\.csv/);
  assert.ok(downloaded.bytes > 0);
  assert.match(await readFile(downloaded.path, "utf8"), /id,name|alpha/);
  await run("browser_tabs", { action: "close", targetId: nav.targetId });
});

test("T33 iframe extraction, frame snapshot and ref click work", async (t) => {
  if (needChrome(t)) return;
  const nav = await run("browser_navigate", { url: server.url + "/iframe.html", newTab: true });
  const frames = await run("browser_extract", { mode: "frames" });
  const child = frames.frames.find((frame) => frame.url.includes("iframe-child"));
  assert.ok(child, "child frame is listed");
  const snapshot = await run("browser_snapshot", { frameId: child.frameId });
  assert.match(snapshot.text, /button/);
  const ref = snapshot.text.match(/(e\d+)\s+button/);
  assert.ok(ref, "frame snapshot exposes a button ref");
  await run("browser_act", { action: "click", ref: ref[1] });
  const output = await run("browser_extract", { mode: "js", frameId: child.frameId, expression: "document.getElementById('inner-out').textContent" });
  assert.match(output.value, /clicked/);
  await run("browser_tabs", { action: "close", targetId: nav.targetId });
});

test("T34 first navigation is captured before subresource traffic", async (t) => {
  if (needChrome(t)) return;
  const nav = await run("browser_navigate", { url: server.url + "/a.html", newTab: true });
  const network = await run("browser_extract", { mode: "network", urlContains: "/a.html" });
  assert.ok(network.events.some((event) => String(event.url).includes("/a.html")), "document request was captured");
  await run("browser_tabs", { action: "close", targetId: nav.targetId });
});

test("T35 click reports an intercepting overlay instead of succeeding", async (t) => {
  if (needChrome(t)) return;
  const nav = await run("browser_navigate", { url: server.url + "/overlay.html", newTab: true });
  const ref = /(e\d+) button "target"/.exec(nav.snapshot)[1];
  await assert.rejects(run("browser_act", { action: "click", ref }), (error) => {
    assert.match(String(error.message), /E_CLICK_INTERCEPTED/);
    return true;
  });
  await run("browser_tabs", { action: "close", targetId: nav.targetId });
});

test("T36 form select and idempotent check/uncheck drive native controls", async (t) => {
  if (needChrome(t)) return;
  const nav = await run("browser_navigate", { url: server.url + "/form.html", newTab: true });
  await run("browser_act", { action: "selectOption", selector: "#color", values: ["green"] });
  assert.equal(await run("browser_extract", { mode: "js", expression: "document.querySelector('#color').value" }).then((value) => value.value), "green");
  await run("browser_act", { action: "check", selector: "#agree" });
  await run("browser_act", { action: "check", selector: "#agree" });
  assert.equal(await run("browser_extract", { mode: "js", expression: "document.querySelector('#agree').checked" }).then((value) => value.value), true);
  await run("browser_act", { action: "uncheck", selector: "#agree" });
  assert.equal(await run("browser_extract", { mode: "js", expression: "document.querySelector('#agree').checked" }).then((value) => value.value), false);
  await run("browser_tabs", { action: "close", targetId: nav.targetId });
});

test("T37 tab locks reject a second task on the same target", async (t) => {
  if (needChrome(t)) return;
  const other = "it-tools-other";
  const nav = await run("browser_navigate", { url: server.url + "/form.html", newTab: true });
  await manager.useTab(other, nav.targetId);
  let blocked = null;
  await manager.withPage(SESSION, async () => {
    blocked = await manager.withPage(other, async () => null, { timeoutMs: 100 }).then(() => null, (error) => error);
  });
  assert.ok(blocked, "second task must be blocked");
  assert.equal(blocked.code, "E_LOCK_TIMEOUT");
  await run("browser_tabs", { action: "close", targetId: nav.targetId });
});

test("T38 browser_task pause/resume/close controls page operations", async (t) => {
  if (needChrome(t)) return;
  const session = "it-tools-task";
  const nav = await runAs("browser_navigate", { url: server.url + "/form.html", newTab: true }, session);
  const active = await runAs("browser_task", { action: "status" }, session);
  assert.equal(active.task.state, "active");
  const paused = await runAs("browser_task", { action: "pause" }, session);
  assert.equal(paused.task.state, "paused");
  await assert.rejects(runAs("browser_act", { action: "click", ref: "e1" }, session), /E_TASK_PAUSED/);
  await runAs("browser_task", { action: "resume" }, session);
  const resumed = await runAs("browser_task", { action: "status" }, session);
  assert.equal(resumed.task.state, "active");
  const closed = await runAs("browser_task", { action: "close", cleanup: "close-owned" }, session);
  assert.equal(closed.task.state, "closed");
  assert.ok(closed.closedTabs.includes(nav.targetId));
  await assert.rejects(runAs("browser_navigate", { url: server.url + "/a.html" }, session), /E_TASK_CLOSED/);
  const restarted = await runAs("browser_task", { action: "start" }, session);
  assert.equal(restarted.task.state, "active");
  const restartedNav = await runAs("browser_navigate", { url: server.url + "/a.html", newTab: true }, session);
  assert.match(restartedNav.url, /a.html/);
  await runAs("browser_task", { action: "close", cleanup: "close-owned" }, session);
});

test("T39 a new manager restores task/current state without stale locks", async (t) => {
  if (needChrome(t)) return;
  const session = "it-tools-restart";
  const nav = await runAs("browser_navigate", { url: server.url + "/form.html", newTab: true }, session);
  const manager2 = new BrowserManager({ cdpUrl: chrome.httpUrl, stateDir });
  try {
    const restored = await manager2.pageFor(session);
    assert.equal(restored.targetId, nav.targetId);
    const status = await manager2.taskStatus(session);
    assert.equal(status.task.state, "active");
    assert.equal(status.locks.length, 0);
  } finally {
    await manager2.close();
  }
  await runAs("browser_tabs", { action: "close", targetId: nav.targetId }, session);
});

test("T40 advanced wait handles response and url_changed", async (t) => {
  if (needChrome(t)) return;
  const nav = await run("browser_navigate", { url: server.url + "/net.html", newTab: true });
  const ref = /(e\d+) button "Load"/.exec(nav.snapshot)[1];
  await run("browser_act", { action: "click", ref });
  const response = await run("browser_wait", { mode: "response", url: "/api/slow", includeBody: true, timeoutMs: 5_000 });
  assert.equal(response.response.status, 200);
  assert.match(String(response.response.body), /"value":42/);
  const before = nav.url;
  await run("browser_extract", { mode: "js", expression: "history.pushState({}, '', '/changed')" });
  const changed = await run("browser_wait", { mode: "url_changed", url: before, timeoutMs: 5_000 });
  assert.equal(changed.changed, true);
  await run("browser_tabs", { action: "close", targetId: nav.targetId });
});

test("T41 strict ownership requires borrow and rejects other-task tabs", async (t) => {
  if (needChrome(t)) return;
  const strict = new BrowserManager({ cdpUrl: chrome.httpUrl, stateDir, strictTabOwnership: true });
  const created = await manager.connection.transport.send("Target.createTarget", { url: "about:blank", background: true });
  const userTarget = created.targetId;
  const owned = await run("browser_navigate", { url: server.url + "/a.html", newTab: true });
  try {
    await assert.rejects(strict.useTab("strict-a", owned.targetId), (error) => { assert.equal(error.code, "E_TAB_OWNER_CONFLICT"); return true; });
    await assert.rejects(strict.useTab("strict-a", userTarget), (error) => { assert.equal(error.code, "E_TAB_BORROW_REQUIRED"); return true; });
    const borrowed = await strict.useTab("strict-a", userTarget, { borrow: true });
    assert.equal(borrowed.targetId, userTarget);
    await assert.rejects(strict.useTab("strict-b", userTarget, { borrow: true }), (error) => { assert.equal(error.code, "E_TAB_LOCKED"); return true; });
  } finally {
    await strict.close();
    await manager.connection.transport.send("Target.closeTarget", { targetId: userTarget }).catch(() => {});
    await run("browser_tabs", { action: "close", targetId: owned.targetId });
  }
});

test("T42 file leases block a second manager on the same tab", async (t) => {
  if (needChrome(t)) return;
  const session = "it-tools-file-lease";
  const a = new BrowserManager({ cdpUrl: chrome.httpUrl, stateDir, fileLease: true });
  const b = new BrowserManager({ cdpUrl: chrome.httpUrl, stateDir, fileLease: true });
  try {
    const nav = await a.navigate(session, server.url + "/a.html", { newTab: true });
    await b.useTab(session, nav.targetId);
    let blocked = null;
    await a.withPage(session, async () => {
      blocked = await b.withPage(session, async () => null, { timeoutMs: 100 }).then(() => null, (error) => error);
    });
    assert.ok(blocked, "second manager must be blocked by the file lease");
    assert.equal(blocked.code, "E_LOCK_TIMEOUT");
    await a.closeTask(session, { cleanup: "close-owned" });
  } finally {
    await a.close();
    await b.close();
  }
});

test("T43 context isolation separates cookies from the shared profile", async (t) => {
  if (needChrome(t)) return;
  const sharedA = "it-shared-a";
  const sharedB = "it-shared-b";
  const sharedName = "bh_shared_" + Date.now();
  const url = server.url + "/cookie.html?name=" + sharedName + "&value=1";
  try {
    await manager.withNavigatedPage(sharedA, url, {}, async (page) => page.evaluate("document.cookie"));
    const sharedValue = await manager.withNavigatedPage(sharedB, url, {}, async (page) => page.evaluate("document.cookie"));
    assert.match(String(sharedValue), new RegExp(sharedName), "shared profile must expose the cookie");

    const contextNameA = "bh_ctx_a_" + Date.now();
    const contextNameB = "bh_ctx_b_" + Date.now();
    const contexts = new BrowserManager({ cdpUrl: chrome.httpUrl, stateDir, isolation: "context" });
    try {
      const contextA = await contexts.withNavigatedPage("ctx-a", server.url + "/cookie.html?name=" + contextNameA + "&value=1", {}, async (page) => page.evaluate("document.cookie"));
      assert.match(String(contextA), new RegExp(contextNameA));
      const contextB = await contexts.withNavigatedPage("ctx-b", server.url + "/cookie.html?name=" + contextNameB + "&value=1", {}, async (page) => page.evaluate("document.cookie"));
      assert.ok(!String(contextB).includes(contextNameA), "context B must not see context A's cookie");
      const ids = await manager.connection.transport.send("Target.getBrowserContexts", {}, { timeoutMs: 5_000 });
      assert.ok((ids.browserContextIds || []).length >= 2, "each context task got an isolated browser context");
    } finally {
      await contexts.close();
    }
  } finally {
    await manager.closeTask(sharedA, { cleanup: "close-owned" }).catch(() => {});
    await manager.closeTask(sharedB, { cleanup: "close-owned" }).catch(() => {});
  }
});

test("T44 persisted context id is validated and disposed by a new manager", async (t) => {
  if (needChrome(t)) return;
  const session = "it-context-persist";
  const a = new BrowserManager({ cdpUrl: chrome.httpUrl, stateDir, isolation: "context" });
  const b = new BrowserManager({ cdpUrl: chrome.httpUrl, stateDir, isolation: "context" });
  try {
    const nav = await a.withNavigatedPage(session, server.url + "/a.html", { newTab: true }, async (page) => ({ targetId: page.targetId }));
    const contextId = a.contexts.get(a.laneFor(session));
    assert.ok(contextId, "context id exists for the task");
    const restored = await b.pageFor(session);
    assert.equal(restored.targetId, nav.targetId);
    await b.closeTask(session, { cleanup: "close-owned" });
    const contexts = await a.connection.transport.send("Target.getBrowserContexts", {});
    assert.ok(!(contexts.browserContextIds || []).includes(contextId), "disposed context is gone");
  } finally {
    await a.closeTask(session, { cleanup: "close-owned" }).catch(() => {});
    await a.close();
    await b.close();
  }
});

test("T45 browser_act expectations assert page state and fail loudly", async (t) => {
  if (needChrome(t)) return;
  const nav = await run("browser_navigate", { url: server.url + "/form.html", newTab: true });
  const required = await run("browser_act", { action: "click", selector: "#submit", expectText: "name is required" });
  assert.equal(required.expectation.ok, true);
  await run("browser_act", { action: "fill", selector: "#name", text: "Ada" });
  const submitted = await run("browser_act", { action: "click", selector: "#submit", expectText: "submitted:Ada", expectSelector: "#ok" });
  assert.equal(submitted.expectation.ok, true);
  await assert.rejects(run("browser_act", { action: "click", selector: "#submit", expectText: "never", expectTimeoutMs: 200 }), /E_EXPECTATION_FAILED/);
  await run("browser_tabs", { action: "close", targetId: nav.targetId });
});

test("T46 read-only tools allow inspection but block mutations", async (t) => {
  if (needChrome(t)) return;
  const roTools = createTools(
    { tools: { register() { throw new Error("createTools must not register by itself"); } }, effect() {}, get() { return undefined; } },
    manager,
    { maxSnapshotNodes: 250, readOnly: true },
    (definition) => definition,
  );
  const ro = (name, args) => roTools.find((definition) => definition.name === name).execute(args, { agent: { session: { id: SESSION } } });
  const nav = await run("browser_navigate", { url: server.url + "/form.html", newTab: true });
  const snapshot = await ro("browser_snapshot", {});
  assert.match(snapshot.text, /button/);
  await assert.rejects(ro("browser_act", { action: "click", selector: "#submit" }), /E_READ_ONLY/);
  await assert.rejects(ro("browser_extract", { mode: "js", expression: "document.cookie" }), /E_READ_ONLY/);
  await assert.rejects(ro("browser_tabs", { action: "new", url: server.url + "/a.html" }), /E_READ_ONLY/);
  await run("browser_tabs", { action: "close", targetId: nav.targetId });
});

test("T47 browser_act drag moves a pointer-draggable element", async (t) => {
  if (needChrome(t)) return;
  const nav = await run("browser_navigate", { url: server.url + "/drag.html", newTab: true });
  const dragged = await run("browser_act", { action: "drag", selector: "#source", toSelector: "#target", steps: 12 });
  assert.equal(dragged.ok, true);
  const text = await run("browser_extract", { mode: "text", selector: "#target" });
  assert.equal(text.value, "dropped");
  await run("browser_tabs", { action: "close", targetId: nav.targetId });
});

test("T48 custom dropdown form can be driven by click and asserted", async (t) => {
  if (needChrome(t)) return;
  const nav = await run("browser_navigate", { url: server.url + "/complex-form.html", newTab: true });
  await run("browser_act", { action: "click", selector: "#menu" });
  const selected = await run("browser_act", { action: "click", selector: "#opt-b", expectText: "Selected: Beta", expectSelector: "#selected" });
  assert.equal(selected.expectation.ok, true);
  await run("browser_tabs", { action: "close", targetId: nav.targetId });
});

test("T49 browser_snapshot paginates the full filtered set beyond 400", async (t) => {
  if (needChrome(t)) return;
  const nav = await run("browser_navigate", { url: server.url + "/many-buttons.html", newTab: true });
  const page = await run("browser_snapshot", { role: "button", offset: 400, limit: 50 });
  assert.equal(page.total, 450);
  assert.equal(page.nodes, 50);
  assert.match(page.text, /button-401/);
  assert.match(page.text, /button-450/);
  const firstPage = await run("browser_snapshot", { role: "button", offset: 0, limit: 2 });
  assert.equal(firstPage.total, 450);
  assert.match(firstPage.text, /button-1/);
  await run("browser_tabs", { action: "close", targetId: nav.targetId });
});

test("T50 CLI exposes navigate, act, wait, extract, snapshot, tabs, task, screenshot and PDF", async (t) => {
  if (needChrome(t)) return;
  const stateDir = await tempDir("bh-cli-surface-");
  const env = { ...process.env, BH_CDP_URL: chrome.httpUrl, BH_STATE_DIR: stateDir };
  const bh = join(ROOT, "dist", "bin", "bh.js");
  const exec = (args) => runCli(process.execPath, [bh, ...args], { env, timeout: 30_000 });

  const opened = await exec(["navigate", server.url + "/form.html"]);
  assert.match(opened.stdout, /form\.html/);
  const filled = await exec(["act", "fill", "--selector", "#name", "--text", "Ada"]);
  assert.match(filled.stdout, /"ok":\s*true/);
  const clicked = await exec(["act", "click", "--selector", "#submit", "--expect-text", "submitted:Ada", "--expect-selector", "#ok"]);
  assert.match(clicked.stdout, /"ok":\s*true/);
  assert.match(clicked.stdout, /"expectation"/);
  const extracted = await exec(["extract", "text", "--selector", "#ok"]);
  assert.match(extracted.stdout, /submitted:Ada/);
  const waited = await exec(["wait", "text", "--text", "submitted"]);
  assert.match(waited.stdout, /"matched":\s*true/);
  const snapshot = JSON.parse((await exec(["snapshot", "--role", "button", "--limit", "2", "--json"])).stdout);
  assert.ok(snapshot.total >= 1);
  assert.ok(snapshot.nodes >= 1);
  const status = JSON.parse((await exec(["status"])).stdout);
  assert.equal(status.connected, true);
  const currentTarget = status.current && status.current.targetId;
  const task = JSON.parse((await exec(["task", "status"])).stdout);
  assert.ok(task.task.state);
  const shot = JSON.parse((await exec(["shot"])).stdout);
  assert.match(shot.path, /\.png$/);
  const pdf = JSON.parse((await exec(["pdf"])).stdout);
  assert.match(pdf.path, /\.pdf$/);
  const created = JSON.parse((await exec(["tabs", "new", server.url + "/b.html"])).stdout);
  assert.ok(created.created || created.targetId);
  const tabId = created.created || created.targetId;
  const used = JSON.parse((await exec(["tabs", "use", tabId])).stdout);
  assert.ok(used.targetId);
  const closed = JSON.parse((await exec(["tabs", "close", tabId])).stdout);
  assert.equal(closed.ok, true);
  assert.ok(currentTarget);
  await exec(["tabs", "close", currentTarget]);
});

test("T51 CLI validates navigate and shot arguments before touching the browser", async () => {
  const stateDir = await tempDir("bh-cli-validate-");
  const bh = join(ROOT, "dist", "bin", "bh.js");
  const env = { ...process.env, BH_STATE_DIR: stateDir };
  const exec = (args) => runCli(process.execPath, [bh, ...args], { env, timeout: 15_000 });
  await assert.rejects(exec(["navigate"]), /navigate needs a URL/);
  await assert.rejects(exec(["navigate", "https://a.example", "https://b.example"]), /exactly one URL/);
  await assert.rejects(exec(["navigate", "file:///etc/passwd"]), /refusing to open/);
  await assert.rejects(exec(["shot", "a.png", "b.png"]), /at most one path/);
  await assert.rejects(exec(["shot", "--bogus"]), /unknown option for shot/);
});

test("T52 CLI validates act/extract/tabs before touching the browser", async () => {
  const stateDir = await tempDir("bh-cli-validate-actions-");
  const bh = join(ROOT, "dist", "bin", "bh.js");
  const env = { ...process.env, BH_STATE_DIR: stateDir };
  const exec = (args) => runCli(process.execPath, [bh, ...args], { env, timeout: 15_000 });
  await assert.rejects(exec(["act"]), /act needs one of/);
  await assert.rejects(exec(["act", "click"]), /needs ref\/selector or x and y/);
  await assert.rejects(exec(["extract", "js"]), /needs an expression/);
  await assert.rejects(exec(["extract", "network", "--selector", "#x"]), /unknown option/);
  await assert.rejects(exec(["tabs", "use"]), /exactly one targetId/);
  await assert.rejects(exec(["tabs", "new", "file:///etc/passwd"]), /refusing to open/);
});
