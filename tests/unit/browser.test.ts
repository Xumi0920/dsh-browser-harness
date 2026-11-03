import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser, assertNavigableUrl } from "../../dist/src/browser.js";
import { readState, rememberOwnedTab, setCurrent } from "../../dist/src/state.js";
import { FakeTransport } from "./helpers/fake-transport.js";
import { cleanupTempDirs, tempDir } from "../helpers/temp.js";


after(cleanupTempDirs);

function pageTarget(targetId, url = "https://example.com/" + targetId) {
  return { targetId, type: "page", url, title: targetId };
}

async function setup({ targets = [], owned = [] } = {}) {
  const stateDir = await tempDir("bh-browser-");
  const transport = new FakeTransport();
  const live = { targets };
  transport.on("Target.getTargets", () => ({ targetInfos: live.targets }));
  transport.on("Target.attachToTarget", () => ({ sessionId: "s" + (++transport.sessionSeq) }));
  transport.on("Target.createTarget", () => ({ targetId: "t-new" }));
  const browser = new Browser({ transport, endpoint: { wsUrl: "ws://fake", source: "unit" }, lane: "unit", config: { stateDir } });
  for (const tab of owned) await rememberOwnedTab("unit", tab, stateDir);
  return { browser, transport, stateDir, setTargets: (next) => { live.targets = next; } };
}

test("listTabs marks harness-owned tabs and filters internal targets", async () => {
  const { browser } = await setup({
    targets: [
      pageTarget("t1"),
      pageTarget("t2"),
      { targetId: "t3", type: "browser", url: "chrome://newtab" },
      pageTarget("t4", "chrome://newtab"),
    ],
    owned: [{ targetId: "t2", url: "https://example.com/t2" }],
  });
  const tabs = await browser.listTabs();
  assert.deepEqual(tabs.map((tab) => tab.targetId), ["t1", "t2"]);
  assert.equal(tabs[0].owned, false);
  assert.equal(tabs[1].owned, true);
});

test("attach reuses one Page per target", async () => {
  const { browser, transport } = await setup({ targets: [pageTarget("t1")] });
  const first = await browser.attach("t1");
  const second = await browser.attach("t1");
  assert.equal(first, second);
  assert.equal(transport.count("Target.attachToTarget"), 1);
});

test("concurrent attaches share one in-flight CDP session", async () => {
  const { browser, transport } = await setup({ targets: [pageTarget("t1")] });
  const [first, second] = await Promise.all([browser.attach("t1"), browser.attach("t1")]);
  assert.equal(first, second);
  assert.equal(transport.count("Target.attachToTarget"), 1);
});

test("closeTab refuses non-owned tabs unless forced", async () => {
  const { browser, transport } = await setup({ targets: [pageTarget("t1")] });
  await assert.rejects(browser.closeTab("t1"), (error: any) => {
    assert.equal(error.code, "E_POLICY_DENIED");
    return true;
  });
  const closed = await browser.closeTab("t1", { force: true });
  assert.deepEqual(closed, { ok: true, closed: "t1" });
  assert.equal(transport.count("Target.closeTarget"), 1);
});

test("closeTab detaches the cached page and forgets the owned tab", async () => {
  const { browser, transport, stateDir } = await setup({
    targets: [pageTarget("t1")],
    owned: [{ targetId: "t1", url: "https://example.com/t1" }],
  });
  const page = await browser.attach("t1");
  await browser.closeTab("t1");
  assert.equal(page.closed, true);
  assert.equal(transport.count("Target.detachFromTarget"), 1);
  const state = await readState("unit", stateDir);
  assert.deepEqual(state.ownedTabs, []);
});

test("listTabs prunes cached pages whose target disappeared", async () => {
  const { browser, transport, setTargets } = await setup({ targets: [pageTarget("t1")] });
  const page = await browser.attach("t1");
  setTargets([pageTarget("t2")]);
  await browser.listTabs();
  assert.equal(page.closed, true);
  assert.equal(transport.count("Target.detachFromTarget"), 1);
});

test("current() returns the remembered tab only while it is live", async () => {
  const { browser, stateDir, setTargets } = await setup({ targets: [pageTarget("t1")] });
  await setCurrent("unit", { targetId: "t1", url: "https://example.com/t1" }, stateDir);
  assert.equal((await browser.current()).targetId, "t1");
  setTargets([]);
  assert.equal(await browser.current(), null);
});

test("newTab remembers ownership and sets the current tab", async () => {
  const { browser, stateDir, setTargets } = await setup({ targets: [pageTarget("t1")] });
  setTargets([pageTarget("t1"), pageTarget("t-new")]);
  const page = await browser.newTab("about:blank");
  assert.equal(page.targetId, "t-new");
  const state = await readState("unit", stateDir);
  assert.deepEqual(state.ownedTabs.map((tab) => tab.targetId), ["t-new"]);
  assert.equal(state.current.targetId, "t-new");
  const tabs = await browser.listTabs();
  assert.equal(tabs.find((tab) => tab.targetId === "t-new").owned, true);
});

test("close detaches every cached page and closes the transport", async () => {
  const { browser, transport } = await setup({ targets: [pageTarget("t1"), pageTarget("t2")] });
  const first = await browser.attach("t1");
  const second = await browser.attach("t2");
  await browser.close();
  assert.equal(first.closed, true);
  assert.equal(second.closed, true);
  assert.equal(transport.count("Target.detachFromTarget"), 2);
  assert.equal(transport.closed, true);
});

test("only http(s) pages and about:blank may be opened", () => {
  assert.equal(assertNavigableUrl("https://example.com/a"), "https://example.com/a");
  assert.equal(assertNavigableUrl("http://127.0.0.1:3638/form.html"), "http://127.0.0.1:3638/form.html");
  assert.equal(assertNavigableUrl("about:blank"), "about:blank");
  for (const blocked of ["file:///C:/Windows/win.ini", "data:text/html,hi", "javascript:alert(1)", "chrome://settings", "devtools://devtools/bundled/inspector.html"]) {
    assert.throws(() => assertNavigableUrl(blocked), (error: any) => {
      assert.equal(error.code, "E_POLICY_DENIED");
      return true;
    }, blocked + " must be rejected");
  }
  assert.throws(() => assertNavigableUrl("not a url"), (error: any) => error.code === "E_BAD_ARG");
});

test("open() creates a new tab instead of navigating a non-owned current tab", async () => {
  const { browser, transport, stateDir } = await setup({ targets: [pageTarget("t-work", "https://work.example/")] });
  await setCurrent("unit", { targetId: "t-work", url: "https://work.example/", title: "Work" }, stateDir);
  const page = await browser.open("https://example.com/new", { waitUntil: "none" });
  assert.equal(page.targetId, "t-new");
  assert.equal(transport.count("Target.createTarget"), 1);
  assert.ok(transport.calls.some((call) => call.method === "Page.navigate" && call.params.url === "https://example.com/new"));
  assert.ok(browser.pages.has("t-new"));
  assert.ok(!browser.pages.has("t-work"), "the work tab is never attached or navigated");
});

test("use rejects file/non-page targets and only URL-matches owned tabs", async () => {
  const { browser, stateDir } = await setup({
    targets: [
      pageTarget("t-work", "https://work.example/app"),
      { targetId: "t-file", type: "page", url: "file:///C:/Windows/win.ini", title: "win.ini" },
      { targetId: "sw-1", type: "service_worker", url: "chrome-extension://x/sw.js" },
      pageTarget("t-owned", "https://owned.example/page"),
    ],
    owned: [{ targetId: "t-owned", url: "https://owned.example/page" }],
  });

  await assert.rejects(browser.use("t-file"), (error: any) => {
    assert.equal(error.code, "E_POLICY_DENIED");
    return true;
  });
  await assert.rejects(browser.use("sw-1"), (error: any) => {
    assert.equal(error.code, "E_ELEMENT_NOT_FOUND");
    return true;
  });
  await assert.rejects(browser.use("work.example"), (error: any) => {
    assert.equal(error.code, "E_ELEMENT_NOT_FOUND");
    return true;
  });

  assert.equal((await browser.use("t-work")).targetId, "t-work", "exact non-owned http tab is allowed");
  assert.equal((await browser.use("owned.example")).targetId, "t-owned", "owned URL substring is allowed");

  const tabs = await browser.listTabs();
  assert.deepEqual(tabs.map((tab) => tab.targetId).sort(), ["t-owned", "t-work"]);

  await setCurrent("unit", { targetId: "t-file", url: "file:///C:/Windows/win.ini" }, stateDir);
  assert.equal(await browser.current(), null, "file pages are never the current tab");
});
