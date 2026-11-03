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
  assert.match(closed.stdout, /"ok":true/);

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
