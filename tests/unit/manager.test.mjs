import test from "node:test";
import assert from "node:assert/strict";
import { BrowserManager } from "../../dist/lib/manager.js";

function fakeConnection() {
  const calls = [];
  const page = {
    targetId: "t1",
    networkEnabled: false,
    startNetworkCapture: async () => {
      calls.push("capture");
      page.networkEnabled = true;
      return { ok: true, capturing: true };
    },
    info: async () => ({ url: "https://example.com/t1", title: "Example" }),
  };
  const browser = {
    version: { product: "Chrome/156" },
    transport: { closed: false },
    calls,
    sessionLane: null,
    async current(lane) { calls.push(["current", lane]); return lane === "dsh-s1" || lane === "dsh-default" ? { targetId: "t1" } : null; },
    async attach(targetId) { calls.push(["attach", targetId]); return page; },
    async listTabs(options) { calls.push(["listTabs", options && options.lane]); return [{ targetId: "t1", owned: true }]; },
    async use(targetId, options) { calls.push(["use", targetId, options && options.lane]); return { targetId: targetId, info: async () => ({ url: "https://example.com/t2" }) }; },
    async newTab(url, options) { calls.push(["newTab", url, options && options.lane]); return { targetId: "t2", info: async () => ({ url }) }; },
    async closeTab(targetId, options) { calls.push(["closeTab", targetId, options && options.lane]); return { ok: true, closed: targetId }; },
    async close() { calls.push("close"); },
    page,
  };
  return browser;
}

function managerWithConnection() {
  const manager = new BrowserManager({});
  const browser = fakeConnection();
  manager.connection = browser;
  return { manager, browser };
}

test("laneFor sanitizes session ids and is stable", () => {
  const manager = new BrowserManager({});
  assert.equal(manager.laneFor(undefined), "dsh-default");
  assert.equal(manager.laneFor("a b/c"), "dsh-a-b-c");
  assert.match(manager.laneFor("session-123"), /^dsh-session-123$/);
  assert.equal(manager.laneFor("x".repeat(80)).length, "dsh-".length + 40);
});

test("pageFor passes the session lane and starts capture once", async () => {
  const { manager, browser } = managerWithConnection();
  const page = await manager.pageFor("s1");
  assert.equal(page.targetId, "t1");
  assert.deepEqual(browser.calls[0], ["current", "dsh-s1"]);
  assert.deepEqual(browser.calls[1], ["attach", "t1"]);
  assert.equal(page.networkEnabled, true);
  await manager.pageFor("s1");
  assert.equal(browser.calls.filter((call) => call === "capture").length, 1, "capture starts once per page");
});

test("pageFor fails with E_NO_TAB when the session has no current tab", async () => {
  const { manager } = managerWithConnection();
  await assert.rejects(manager.pageFor("other"), (error) => {
    assert.equal(error.code, "E_NO_TAB");
    return true;
  });
});

test("navigate/openTab/use/close pass the session lane", async () => {
  const { manager, browser } = managerWithConnection();
  browser.open = async (url, options) => {
    browser.calls.push(["open", url, options && options.lane]);
    return { targetId: "t1", info: async () => ({ url }) };
  };
  await manager.navigate("s1", "https://example.com", { newTab: true });
  await manager.openTab("s1", "https://example.com/new");
  await manager.useTab("s1", "t1");
  await manager.closeTab("s1", "t1");
  assert.deepEqual(browser.calls.filter((call) => Array.isArray(call) && call[0] === "open")[0], ["open", "https://example.com", "dsh-s1"]);
  assert.deepEqual(browser.calls.find((call) => Array.isArray(call) && call[0] === "newTab"), ["newTab", "https://example.com/new", "dsh-s1"]);
  assert.deepEqual(browser.calls.find((call) => Array.isArray(call) && call[0] === "use"), ["use", "t1", "dsh-s1"]);
  assert.deepEqual(browser.calls.find((call) => Array.isArray(call) && call[0] === "closeTab"), ["closeTab", "t1", "dsh-s1"]);
});

test("listTabs returns tabs plus the session current tab", async () => {
  const { manager } = managerWithConnection();
  const result = await manager.listTabs("s1");
  assert.equal(result.tabs[0].owned, true);
  assert.equal(result.current.targetId, "t1");
});

test("close awaits the connection close and clears it", async () => {
  const { manager, browser } = managerWithConnection();
  await manager.close();
  assert.ok(browser.calls.includes("close"));
  assert.equal(manager.connection, null);
});

test("ensure returns the existing connection without reconnecting", async () => {
  const { manager, browser } = managerWithConnection();
  assert.equal(await manager.ensure(), browser);
});

test("ensure forwards tab-group and extension settings to the browser factory", async () => {
  let captured = null;
  const manager = new BrowserManager({
    browser: "chrome-beta",
    dialogPolicy: "auto-dismiss",
    tabGroups: false,
    tabGroupTitle: "任务 {session}",
    tabGroupColor: "blue",
    extensionPath: "/opt/dsh/extension",
    extensionId: "abcdef",
    browserFactory: async (options) => {
      captured = options;
      return { transport: { closed: false } };
    },
  });
  await manager.ensure();
  assert.deepEqual(captured, {
    browser: "chrome-beta",
    cdpUrl: undefined,
    ws: undefined,
    stateDir: undefined,
    downloadDir: undefined,
    dialogPolicy: "auto-dismiss",
    tabGroups: false,
    tabGroupTitle: "任务 {session}",
    tabGroupColor: "blue",
    extensionPath: "/opt/dsh/extension",
    extensionId: "abcdef",
    lane: "dsh",
  });
});
