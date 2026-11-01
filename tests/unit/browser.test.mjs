import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "../../src/browser.mjs";
import { readState, rememberOwnedTab, setCurrent } from "../../src/state.mjs";
import { FakeTransport } from "./fake-transport.mjs";

function pageTarget(targetId, url = "https://example.com/" + targetId) {
  return { targetId, type: "page", url, title: targetId };
}

async function setup({ targets = [], owned = [] } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), "bh-browser-"));
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

test("closeTab refuses non-owned tabs unless forced", async () => {
  const { browser, transport } = await setup({ targets: [pageTarget("t1")] });
  await assert.rejects(browser.closeTab("t1"), (error) => {
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
