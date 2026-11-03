import test from "node:test";
import assert from "node:assert/strict";
import { createTools } from "../../dist/lib/tools.js";
import { HarnessError } from "../../dist/src/errors.js";

function makeCtx() {
  return {
    tools: { register() { throw new Error("createTools must not register by itself"); } },
    effect() {},
    get() { return undefined; },
  };
}

function fakeManager(overrides = {}) {
  const page = {
    targetId: "T1",
    info: async () => ({ url: "https://example.com", title: "Example", readyState: "complete", viewport: { width: 1280, height: 800 } }),
    snapshot: async () => ({ nodes: [{ ref: "e1", role: "button", name: "Go", center: { x: 10, y: 20 } }, { ref: "e2", role: "link", name: "Docs" }], truncated: false }),
    click: async () => ({ ok: true, x: 1, y: 2 }),
    type: async () => ({ ok: true }),
    fill: async () => ({ ok: true }),
    press: async () => ({ ok: true }),
    scroll: async () => ({ ok: true }),
    text: async () => "hello",
    evaluate: async () => "value",
    networkEvents: () => [{ url: "https://example.com/api" }],
    screenshot: async () => ({ path: "C:/tmp/shot.png", width: 100, height: 50, bytes: 10 }),
  };
  return {
    status: async () => ({ connected: true, version: { product: "Chrome/156" }, tabs: [], current: null, endpoints: [] }),
    navigate: async () => page,
    pageFor: async () => page,
    listTabs: async () => ({ tabs: [{ targetId: "T1", url: "https://example.com", owned: true }], current: { targetId: "T1" } }),
    useTab: async (sessionId, id) => ({ targetId: id, info: async () => ({ url: "https://example.com" }) }),
    openTab: async (sessionId, url) => ({ targetId: "T2", info: async () => ({ url: url || "about:blank" }) }),
    closeTab: async (sessionId, targetId) => ({ ok: true, closed: targetId }),
    ...overrides,
  };
}

function build(manager = fakeManager()) {
  return createTools(makeCtx(), manager, { maxSnapshotNodes: 50 }, (definition) => definition);
}

test("exposes the expected tool surface", () => {
  const tools = build();
  assert.deepEqual(tools.map((definition) => definition.name), [
    "browser_status",
    "browser_wait",
    "browser_navigate",
    "browser_snapshot",
    "browser_act",
    "browser_extract",
    "browser_screenshot",
    "browser_pdf",
    "browser_tabs",
  ]);
  for (const definition of tools) {
    assert.ok(definition.output && definition.output.schema, definition.name + " declares output.schema");
    assert.equal(typeof definition.output.render, "function", definition.name + " declares render");
    assert.equal(typeof definition.execute, "function");
  }
});

test("parameters expose required fields", () => {
  const tools = build();
  const navigate = tools.find((definition) => definition.name === "browser_navigate");
  assert.equal(navigate.parameters.url.required, undefined, "url is optional when action=back/forward/reload");
  assert.deepEqual(navigate.parameters.action.enum, ["open", "back", "forward", "reload"]);
  const act = tools.find((definition) => definition.name === "browser_act");
  assert.equal(act.parameters.action.required, true);
  assert.ok(act.parameters.action.enum.includes("hover"));
  assert.ok(act.parameters.action.enum.includes("dialog"));
});

test("browser_navigate returns info plus snapshot text", async () => {
  const tools = build();
  const navigate = tools.find((definition) => definition.name === "browser_navigate");
  const value = await navigate.execute({ url: "https://example.com" }, { agent: { session: { id: "s1" } } });
  assert.equal(value.url, "https://example.com");
  assert.match(value.snapshot, /e1 button "Go"/);
  assert.equal(value.nodes, 2);
});

test("browser_act click routes ref and returns the coordinate result", async () => {
  let seen = null;
  const manager = fakeManager();
  const page = await manager.pageFor();
  page.click = async (target, options) => { seen = { target, options }; return { ok: true, x: 5, y: 6 }; };
  manager.pageFor = async () => page;
  const tools = build(manager);
  const act = tools.find((definition) => definition.name === "browser_act");
  const value = await act.execute({ action: "click", ref: "e1" }, {});
  assert.deepEqual(seen.target, { ref: "e1", selector: undefined });
  assert.deepEqual(value, { action: "click", ok: true, x: 5, y: 6 });
});

test("browser_act rejects an action without a target", async () => {
  const tools = build();
  const act = tools.find((definition) => definition.name === "browser_act");
  await assert.rejects(act.execute({ action: "click" }, {}), /E_BAD_ARG/);
});

test("harness errors surface as tool errors with their code", async () => {
  const manager = fakeManager({ pageFor: async () => { throw new HarnessError("E_NO_TAB", "no tab"); } });
  const tools = build(manager);
  const snapshot = tools.find((definition) => definition.name === "browser_snapshot");
  await assert.rejects(snapshot.execute({}, {}), /E_NO_TAB: no tab/);
});

test("output render produces text content blocks", () => {
  const tools = build();
  const status = tools.find((definition) => definition.name === "browser_status");
  const blocks = status.output.render({}, { connected: true });
  assert.equal(blocks[0].type, "text");
  assert.match(blocks[0].text, /connected/);
});

test("browser_extract network reports capture state and event count", async () => {
  const tools = build();
  const extract = tools.find((definition) => definition.name === "browser_extract");
  const value = await extract.execute({ mode: "network" }, { agent: { session: { id: "s1" } } });
  assert.equal(value.mode, "network");
  assert.equal(value.count, 1);
  assert.equal(value.capturing, false, "fake page has no capture flag");
  assert.equal(value.events[0].url, "https://example.com/api");
});

test("browser_extract network includeBody attaches response bodies", async () => {
  const manager = fakeManager();
  const page = {
    info: async () => ({ url: "https://example.com" }),
    networkEvents: () => [{ requestId: "r1", url: "https://example.com/api", status: 200 }],
    networkBodies: async (events) => events.map((event) => ({ ...event, body: "{\"value\":42}" })),
  };
  manager.pageFor = async () => page;
  const tools = build(manager);
  const extract = tools.find((definition) => definition.name === "browser_extract");
  const value = await extract.execute({ mode: "network", includeBody: true }, {});
  assert.equal(value.events[0].body, '{"value":42}');
  assert.equal(value.count, 1);
});

test("snapshot truncated flag is truthful when text is line-capped", async () => {
  const manager = fakeManager();
  const page = {
    targetId: "T1",
    info: async () => ({ url: "https://example.com" }),
    snapshot: async () => ({ nodes: Array.from({ length: 250 }, (_, index) => ({ ref: "e" + (index + 1), role: "button", name: "B" + index })), truncated: false }),
  };
  manager.pageFor = async () => page;
  const tools = build(manager);
  const snapshotTool = tools.find((definition) => definition.name === "browser_snapshot");
  const value = await snapshotTool.execute({}, {});
  assert.equal(value.nodes, 250);
  assert.equal(value.truncated, true, "200-line cap must be reported as truncated");
  assert.match(value.text, /snapshot truncated \(200 of 250 nodes\)/);
});

test("browser_tabs list returns owned flags and the current tab", async () => {
  const tools = build();
  const tabs = tools.find((definition) => definition.name === "browser_tabs");
  const value = await tabs.execute({ action: "list" }, {});
  assert.equal(value.tabs[0].owned, true);
  assert.equal(value.current.targetId, "T1");
});

test("browser_tabs routes use/new/close through the manager", async () => {
  const calls = [];
  const manager = fakeManager({
    useTab: async (sessionId, id) => { calls.push(["use", sessionId, id]); return { targetId: id, info: async () => ({ url: "https://example.com" }) }; },
    openTab: async (sessionId, url) => { calls.push(["new", sessionId, url]); return { targetId: "T2", info: async () => ({ url }) }; },
    closeTab: async (sessionId, targetId) => { calls.push(["close", sessionId, targetId]); return { ok: true, closed: targetId }; },
  });
  const tools = build(manager);
  const tabs = tools.find((definition) => definition.name === "browser_tabs");
  const exec = { agent: { session: { id: "s9" } } };
  assert.equal((await tabs.execute({ action: "use", targetId: "T1" }, exec)).used, "T1");
  assert.equal((await tabs.execute({ action: "new", url: "https://x.test" }, exec)).created, "T2");
  assert.deepEqual(await tabs.execute({ action: "close", targetId: "T1" }, exec), { ok: true, closed: "T1" });
  assert.deepEqual(calls, [["use", "s9", "T1"], ["new", "s9", "https://x.test"], ["close", "s9", "T1"]]);
});

const LONG = "x".repeat(200_001);

test("browser_extract caps text, html and js output at 200k chars", async () => {
  const tools = build();
  const extract = tools.find((definition) => definition.name === "browser_extract");
  const htmlManager = fakeManager();
  htmlManager.pageFor = async () => ({ evaluate: async () => LONG, text: async () => LONG });
  const htmlTools = build(htmlManager);
  const htmlExtract = htmlTools.find((definition) => definition.name === "browser_extract");
  const html = await htmlExtract.execute({ mode: "html" }, {});
  assert.equal(html.value.length, 200_000);
  assert.equal(html.truncated, true);
  const text = await htmlExtract.execute({ mode: "text" }, {});
  assert.equal(text.value.length, 200_000);
  assert.equal(text.truncated, true);

  const jsManager = fakeManager();
  jsManager.pageFor = async () => ({ evaluate: async () => LONG });
  const jsTools = build(jsManager);
  const jsExtract = jsTools.find((definition) => definition.name === "browser_extract");
  const js = await jsExtract.execute({ mode: "js", expression: "longString()" }, {});
  assert.equal(js.truncated, true);
  assert.equal(js.value.length, 200_000);

  const objManager = fakeManager();
  objManager.pageFor = async () => ({ evaluate: async () => ({ text: LONG }) });
  const objTools = build(objManager);
  const objExtract = objTools.find((definition) => definition.name === "browser_extract");
  const obj = await objExtract.execute({ mode: "js", expression: "bigObject()" }, {});
  assert.equal(obj.truncated, true);
  assert.equal(obj.format, "json");
  assert.equal(obj.value.length, 200_000);
});

test("browser_act routes type, fill, press and scroll to the page", async () => {
  const seen = [];
  const manager = fakeManager();
  manager.pageFor = async () => ({
    type: async (text) => { seen.push(["type", text]); return { ok: true }; },
    fill: async (target, options) => { seen.push(["fill", target, options]); return { ok: true }; },
    press: async (key, options) => { seen.push(["press", key, options]); return { ok: true }; },
    scroll: async (delta) => { seen.push(["scroll", delta]); return { ok: true }; },
  });
  const act = build(manager).find((definition) => definition.name === "browser_act");
  await act.execute({ action: "type", text: "hi" }, {});
  await act.execute({ action: "fill", ref: "e1", text: "x" }, {});
  await act.execute({ action: "press", key: "Enter", modifiers: "Control,Shift" }, {});
  await act.execute({ action: "scroll", dx: 1, dy: 200 }, {});
  assert.deepEqual(seen[0], ["type", "hi"]);
  assert.deepEqual(seen[1], ["fill", { ref: "e1", selector: undefined, text: "x" }, { verify: true }]);
  assert.deepEqual(seen[2], ["press", "Enter", { modifiers: ["Control", "Shift"] }]);
  assert.deepEqual(seen[3], ["scroll", { dx: 1, dy: 200 }]);
});

test("browser_act fill requires ref or selector", async () => {
  const act = build().find((definition) => definition.name === "browser_act");
  await assert.rejects(act.execute({ action: "fill", text: "x" }, {}), /E_BAD_ARG/);
});

test("browser_screenshot returns the page screenshot result", async () => {
  const manager = fakeManager();
  manager.pageFor = async () => ({ screenshot: async (options) => ({ path: "/tmp/shot.png", bytes: 12, options }) });
  const tool = build(manager).find((definition) => definition.name === "browser_screenshot");
  const value = await tool.execute({ fullPage: true }, {});
  assert.equal(value.path, "/tmp/shot.png");
  assert.equal(value.bytes, 12);
});

test("browser_navigate forwards newTab/waitUntil and reports truncation", async () => {
  let seen = null;
  const manager = fakeManager();
  manager.navigate = async (sessionId, url, options) => {
    seen = { sessionId, url, options };
    return {
      targetId: "T9",
      info: async () => ({ url, title: "T", readyState: "complete", viewport: { width: 800, height: 600 } }),
      snapshot: async () => ({ nodes: Array.from({ length: 250 }, (_, index) => ({ ref: "e" + (index + 1), role: "button", name: "b" + index })), truncated: false }),
    };
  };
  const navigate = build(manager).find((definition) => definition.name === "browser_navigate");
  const value = await navigate.execute({ url: "https://example.com", newTab: true, waitUntil: "domcontentloaded" }, { agent: { session: { id: "s1" } } });
  assert.deepEqual(seen, { sessionId: "s1", url: "https://example.com", options: { newTab: true, waitUntil: "domcontentloaded" } });
  assert.equal(value.nodes, 250);
  assert.equal(value.truncated, true);
});

test("browser_status passes tab group status through", async () => {
  const manager = fakeManager({
    status: async () => ({ connected: true, version: { product: "Chrome/156" }, tabs: [], current: null, endpoints: [], tabGroups: { enabled: true, available: false, extensionId: null, error: "headless" } }),
  });
  const status = build(manager).find((definition) => definition.name === "browser_status");
  const value = await status.execute({}, {});
  assert.equal(value.tabGroups.enabled, true);
  assert.equal(value.tabGroups.error, "headless");
});

test("browser_extract is not marked concurrency-safe", () => {
  const extract = build().find((definition: any) => definition.name === "browser_extract");
  assert.equal(extract.isConcurrencySafe(), false);
});

test("status and network outputs redact token-like URLs and headers", async () => {
  const manager = fakeManager({
    status: async () => ({
      connected: true,
      version: { product: "Chrome/156" },
      tabs: [{ targetId: "T1", url: "https://example.com/app?access_token=abc123&x=1", title: "App" }],
      current: { targetId: "T1", url: "https://example.com/app?session=xyz789", title: "App" },
      endpoints: [],
    }),
  });
  const status = build(manager).find((definition: any) => definition.name === "browser_status");
  const statusValue: any = await status.execute({}, {});
  assert.ok(!String(statusValue.tabs[0].url).includes("abc123"));
  assert.match(statusValue.tabs[0].url, /redacted/i);
  assert.ok(!String(statusValue.current.url).includes("xyz789"));

  const page = {
    targetId: "T1",
    info: async () => ({ url: "https://example.com", title: "Example" }),
    networkEvents: () => [{
      url: "https://example.com/api?token=secret42&page=1",
      status: 200,
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
    }],
    networkEnabled: true,
  };
  const networkManager = fakeManager({ pageFor: async () => page });
  const extract = build(networkManager).find((definition: any) => definition.name === "browser_extract");
  const network: any = await extract.execute({ mode: "network" }, {});
  assert.ok(!network.events[0].url.includes("secret42"));
  assert.match(network.events[0].url, /redacted/i);
  assert.equal(network.events[0].headers.authorization, "[redacted]");
  assert.equal(network.events[0].headers["content-type"], "application/json");
});

test("browser_act type focuses an explicit ref/selector before typing", async () => {
  const seen = [];
  const manager = fakeManager();
  manager.pageFor = async () => ({
    focus: async (target) => { seen.push(["focus", target]); return { ok: true }; },
    type: async (text) => { seen.push(["type", text]); return { ok: true }; },
  });
  const act = build(manager).find((definition) => definition.name === "browser_act");
  await act.execute({ action: "type", ref: "e1", text: "yo" }, {});
  await act.execute({ action: "type", selector: "#name", text: "hi" }, {});
  assert.deepEqual(seen, [
    ["focus", { ref: "e1", selector: undefined }],
    ["type", "yo"],
    ["focus", { ref: undefined, selector: "#name" }],
    ["type", "hi"],
  ]);
});

test("browser_wait routes selector, text, network_idle and delay modes", async () => {
  const seen = [];
  const manager = fakeManager();
  manager.pageFor = async () => ({
    waitForSelector: async (selector, options) => { seen.push(["selector", selector, options]); return { tag: "input" }; },
    waitForFunction: async (expression, options) => { seen.push(["text", expression, options]); return true; },
    waitForNetworkIdle: async (options) => { seen.push(["network", options]); return { ok: true, events: 0 }; },
  });
  const wait = build(manager).find((definition) => definition.name === "browser_wait");
  await wait.execute({ mode: "selector", selector: "#name", visible: true }, {});
  await wait.execute({ mode: "text", text: "ready" }, {});
  await wait.execute({ mode: "network_idle", idleMs: 100 }, {});
  await wait.execute({ mode: "delay", delayMs: 10 }, {});
  assert.deepEqual(seen[0], ["selector", "#name", { timeoutMs: 30000, visible: true }]);
  assert.match(seen[1][1], /ready/);
  assert.deepEqual(seen[2], ["network", { timeoutMs: 30000, idleMs: 100 }]);
});

test("browser_act hover and dialog route to the page", async () => {
  const seen = [];
  const manager = fakeManager();
  manager.pageFor = async () => ({
    hover: async (target) => { seen.push(["hover", target]); return { ok: true, x: 1, y: 2 }; },
    dialog: () => ({ type: "confirm", message: "ok?" }),
    handleDialog: async (options) => { seen.push(["dialog", options]); return { ok: true, accepted: true }; },
  });
  const act = build(manager).find((definition) => definition.name === "browser_act");
  await act.execute({ action: "hover", ref: "e1" }, {});
  await act.execute({ action: "dialog", accept: true, promptText: "yes" }, {});
  assert.deepEqual(seen[0], ["hover", { ref: "e1", selector: undefined }]);
  assert.deepEqual(seen[1], ["dialog", { accept: true, promptText: "yes" }]);
});

test("browser_extract console mode returns redacted console events", async () => {
  const manager = fakeManager();
  manager.pageFor = async () => ({
    consoleEvents: () => [{ source: "console", level: "error", text: "failed https://example.com/?access_token=secret" }],
  });
  const extract = build(manager).find((definition) => definition.name === "browser_extract");
  const value = await extract.execute({ mode: "console" }, {});
  assert.equal(value.events.length, 1);
  assert.ok(!value.events[0].text.includes("secret"));
});

test("browser_navigate routes history actions to page.history", async () => {
  const seen = [];
  const manager = fakeManager();
  const page = {
    targetId: "T1",
    info: async () => ({ url: "https://example.com", title: "Example", readyState: "complete" }),
    snapshot: async () => ({ nodes: [], truncated: false }),
    history: async (action, options) => { seen.push([action, options]); return { ok: true }; },
  };
  manager.pageFor = async () => page;
  const navigate = build(manager).find((definition) => definition.name === "browser_navigate");
  await navigate.execute({ action: "back" }, {});
  await navigate.execute({ action: "reload" }, {});
  assert.deepEqual(seen[0], ["back", { waitUntil: undefined }]);
  assert.deepEqual(seen[1], ["reload", { waitUntil: undefined }]);
});

test("browser_screenshot and browser_pdf route element clip and PDF", async () => {
  const seen = [];
  const manager = fakeManager();
  const page = {
    targetId: "T1",
    boxFor: async (target) => { seen.push(["box", target]); return { x: 1, y: 2, width: 3, height: 4 }; },
    screenshot: async (options) => { seen.push(["screenshot", options]); return { path: "shot.png", bytes: 1 }; },
    pdf: async (options) => { seen.push(["pdf", options]); return { path: "page.pdf", bytes: 1 }; },
  };
  manager.pageFor = async () => page;
  const tools = build(manager);
  await tools.find((definition) => definition.name === "browser_screenshot").execute({ ref: "e1" }, {});
  await tools.find((definition) => definition.name === "browser_pdf").execute({ path: "page.pdf" }, {});
  assert.deepEqual(seen[0], ["box", { ref: "e1", selector: undefined }]);
  assert.deepEqual(seen[1], ["screenshot", { fullPage: false, path: undefined, clip: { x: 1, y: 2, width: 3, height: 4 } }]);
  assert.deepEqual(seen[2], ["pdf", { path: "page.pdf", printBackground: true }]);
});
