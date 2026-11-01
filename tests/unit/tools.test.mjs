import test from "node:test";
import assert from "node:assert/strict";
import { createTools } from "../../lib/tools.js";
import { HarnessError } from "../../src/errors.mjs";

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
    browserFor: async () => ({
      listTabs: async () => [{ targetId: "T1", url: "https://example.com" }],
      current: async () => ({ targetId: "T1" }),
      use: async (id) => ({ targetId: id, info: async () => ({ url: "https://example.com" }) }),
      newTab: async () => ({ targetId: "T2", info: async () => ({ url: "about:blank" }) }),
      closeTab: async () => ({ ok: true }),
    }),
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
    "browser_navigate",
    "browser_snapshot",
    "browser_act",
    "browser_extract",
    "browser_screenshot",
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
  assert.equal(navigate.parameters.url.required, true);
  const act = tools.find((definition) => definition.name === "browser_act");
  assert.equal(act.parameters.action.required, true);
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
