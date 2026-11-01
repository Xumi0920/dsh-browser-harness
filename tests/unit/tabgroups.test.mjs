import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TAB_GROUP_COLORS,
  TAB_GROUP_EXTENSION_NAME,
  TabGroupBridge,
  tabGroupColorFor,
  tabGroupSessionTag,
  tabGroupTitleFor,
} from "../../dist/src/tabgroups.js";
import { FakeTransport } from "./helpers/fake-transport.mjs";

const EXTENSION_PATH = join(tmpdir(), "bh-package", "extension");
const EXTENSION_URL = "chrome-extension://ext-1/sw.js";

function fakePage(title = "Original title") {
  const page = {
    targetId: "t-page",
    title,
    titles: [title],
    async evaluate(expressionOrFn, options = {}) {
      if (typeof expressionOrFn === "function") {
        page.title = options.args ? options.args[0] : "";
        page.titles.push(page.title);
        return undefined;
      }
      if (expressionOrFn === "document.title") return page.title;
      return null;
    },
  };
  return page;
}

function bridgeTransport({ extensions = [{ id: "ext-1", name: TAB_GROUP_EXTENSION_NAME, path: EXTENSION_PATH }], workerUrl = EXTENSION_URL } = {}) {
  const transport = new FakeTransport();
  transport.on("Extensions.getExtensions", () => ({ extensions }));
  transport.on("Extensions.loadUnpacked", () => ({ id: "ext-1" }));
  transport.on("Target.getTargets", () => ({ targetInfos: workerUrl ? [{ type: "service_worker", url: workerUrl, targetId: "sw-1" }] : [] }));
  transport.on("Target.attachToTarget", () => ({ sessionId: "sw-session" }));
  transport.on("Target.detachFromTarget", () => ({}));
  transport.on("Runtime.evaluate", (params) => {
    const expression = String(params.expression);
    if (expression === "typeof chrome") return { result: { value: "object" } };
    if (expression.includes("chrome.tabs.query")) return { result: { value: { ok: true, groupId: 42, tabId: 7, created: true } } };
    if (expression.includes("chrome.tabGroups.get")) return { result: { value: 42 } };
    if (expression.includes("chrome.tabGroups.query")) return { result: { value: [{ id: 42, title: "DSH · probe", color: "blue" }] } };
    return { result: { value: null } };
  });
  return transport;
}

function bridgeFor(transport, options = {}) {
  const browser = { transport };
  return new TabGroupBridge(browser, { extensionPath: EXTENSION_PATH, ...options });
}

test("tab group titles and colors are stable per lane", () => {
  assert.equal(tabGroupTitleFor("dsh-abc123"), "DSH · abc123");
  assert.equal(tabGroupTitleFor(undefined), "DSH · default");
  assert.equal(tabGroupSessionTag("dsh-abc123"), "abc123");
  assert.equal(tabGroupTitleFor("dsh-abc123", "任务 {session}"), "任务 abc123");
  assert.equal(tabGroupTitleFor("dsh-abc123", "{lane}"), "dsh-abc123");
  assert.equal(tabGroupTitleFor(undefined, "T-{session}"), "T-default");
  assert.ok(TAB_GROUP_COLORS.includes(tabGroupColorFor("dsh-abc123")));
  assert.equal(tabGroupColorFor("dsh-abc123"), tabGroupColorFor("dsh-abc123"));
});

test("groupTab finds the tab by title nonce and restores the title", async () => {
  const transport = bridgeTransport();
  const bridge = bridgeFor(transport);
  const page = fakePage("Original title");
  const result = await bridge.groupTab(page, { title: "DSH · task", color: "blue", groupId: null });
  assert.equal(result.ok, true);
  assert.equal(result.groupId, 42);
  assert.equal(page.title, "Original title", "page title is restored after grouping");
  const groupEval = transport.calls.filter((call) => call.method === "Runtime.evaluate" && String(call.params.expression).includes("chrome.tabs.query"));
  assert.equal(groupEval.length, 1);
  assert.match(groupEval[0].params.expression, /DSH-TMP-[a-z0-9]+/);
  assert.match(groupEval[0].params.expression, /DSH · task/);
  assert.equal(bridge.info().available, true);
});

test("groupTab reuses an existing group id", async () => {
  const transport = bridgeTransport();
  const bridge = bridgeFor(transport);
  const page = fakePage();
  const result = await bridge.groupTab(page, { title: "DSH · task", color: "green", groupId: 99 });
  assert.equal(result.ok, true);
  const groupEval = transport.calls.filter((call) => call.method === "Runtime.evaluate" && String(call.params.expression).includes("chrome.tabs.query"));
  assert.match(groupEval[0].params.expression, /let id = 99/);
});

test("the bridge installs the bundled extension when it is missing", async () => {
  const transport = new FakeTransport();
  transport.on("Extensions.getExtensions", () => ({ extensions: [] }));
  transport.on("Extensions.loadUnpacked", () => ({ id: "ext-1" }));
  transport.on("Target.getTargets", () => ({ targetInfos: [{ type: "service_worker", url: EXTENSION_URL, targetId: "sw-1" }] }));
  transport.on("Target.attachToTarget", () => ({ sessionId: "sw-session" }));
  transport.on("Runtime.evaluate", (params) => {
    const expression = String(params.expression);
    if (expression === "typeof chrome") return { result: { value: "object" } };
    return { result: { value: { ok: true, groupId: 7, tabId: 3, created: true } } };
  });
  const bridge = bridgeFor(transport);
  const result = await bridge.groupTab(fakePage(), { title: "DSH · t", color: "cyan", groupId: null });
  assert.equal(result.ok, true);
  assert.equal(transport.count("Extensions.loadUnpacked"), 1);
  assert.equal(bridge.info().extensionId, "ext-1");
});

test("a missing worker is reported once and retried after the cooldown", async () => {
  const transport = bridgeTransport({ workerUrl: null });
  const bridge = bridgeFor(transport);
  const result = await bridge.groupTab(fakePage(), { title: "DSH · t", color: "blue", groupId: null });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "extension-unavailable");
  assert.match(bridge.info().error, /worker is not running/);
  const calls = transport.count("Extensions.getExtensions");
  const again = await bridge.groupTab(fakePage(), { title: "DSH · t", color: "blue", groupId: null });
  assert.equal(again.ok, false);
  assert.equal(transport.count("Extensions.getExtensions"), calls, "cooldown avoids retrying every tab");
  bridge.resetFailure();
  await bridge.groupTab(fakePage(), { title: "DSH · t", color: "blue", groupId: null });
  assert.equal(transport.count("Extensions.getExtensions"), calls + 1);
});

test("listGroups and groupExists read the worker", async () => {
  const transport = bridgeTransport();
  const bridge = bridgeFor(transport);
  assert.deepEqual(await bridge.listGroups(), [{ id: 42, title: "DSH · probe", color: "blue" }]);
  assert.equal(await bridge.groupExists(42), true);
  assert.equal(await bridge.groupExists(null), false);
});

test("dispose detaches the worker session", async () => {
  const transport = bridgeTransport();
  const bridge = bridgeFor(transport);
  assert.equal(await bridge.ensure(), true);
  await bridge.dispose();
  const detach = transport.calls.filter((call) => call.method === "Target.detachFromTarget");
  assert.equal(detach.length, 1);
  assert.equal(detach[0].params.sessionId, "sw-session");
  assert.equal(bridge.info().available, false);
});

test("an extension install failure is reported once and cooled down", async () => {
  const transport = new FakeTransport();
  transport.on("Extensions.getExtensions", () => ({ extensions: [] }));
  transport.on("Extensions.loadUnpacked", () => { throw new Error("load failed"); });
  const bridge = bridgeFor(transport);
  const result = await bridge.groupTab(fakePage(), { title: "DSH · t", color: "blue", groupId: null });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "extension-unavailable");
  assert.match(bridge.info().error, /load failed/);
  const calls = transport.count("Extensions.getExtensions");
  const again = await bridge.groupTab(fakePage(), { title: "DSH · t", color: "blue", groupId: null });
  assert.equal(again.ok, false);
  assert.equal(transport.count("Extensions.getExtensions"), calls, "cooldown prevents retry storms");
});

test("a dead worker session is re-attached before retrying once", async () => {
  const transport = bridgeTransport();
  let evaluations = 0;
  transport.on("Runtime.evaluate", (params) => {
    const expression = String(params.expression);
    if (expression === "typeof chrome") return { result: { value: "object" } };
    evaluations += 1;
    if (evaluations === 1) throw new Error("Session with given id not found");
    return { result: { value: "recovered" } };
  });
  const bridge = bridgeFor(transport);
  const value = await bridge.evaluate("chrome.tabs.query({})");
  assert.equal(value, "recovered");
  assert.ok(transport.count("Target.attachToTarget") >= 2, "the worker is re-attached before the retry");
});
