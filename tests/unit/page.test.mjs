import test from "node:test";
import assert from "node:assert/strict";
import { Page } from "../../src/page.mjs";
import { FakeTransport, quad } from "./fake-transport.mjs";

const AX_NODES = [
  { role: { value: "button" }, backendDOMNodeId: 10, name: { value: "Go" } },
  { role: { value: "link" }, backendDOMNodeId: 11, name: { value: "Docs" } },
];

function setupPage({ ax = AX_NODES } = {}) {
  const transport = new FakeTransport();
  transport.on("Accessibility.getFullAXTree", () => ({ nodes: ax }));
  transport.on("DOM.getBoxModel", () => quad(10, 20, 40, 20));
  transport.on("DOM.getDocument", () => ({ root: { nodeId: 1 } }));
  transport.on("DOM.querySelector", () => ({ nodeId: 2 }));
  transport.on("DOM.describeNode", () => ({ node: { backendNodeId: 5 } }));
  transport.on("DOM.resolveNode", () => ({ object: { objectId: "obj-5" } }));
  transport.on("Page.navigate", () => ({}));
  transport.on("Runtime.evaluate", () => ({ result: { value: "complete" } }));
  transport.on("Network.getResponseBody", () => ({ body: JSON.stringify({ value: 42 }) }));
  const browser = {
    transport,
    config: { dialogPolicy: "auto-dismiss", focusEmulation: false, stateDir: "/tmp/bh-unit", downloadDir: "/tmp/bh-unit/downloads" },
  };
  const page = new Page(browser, { sessionId: "s1", targetId: "t1" });
  return { page, transport };
}

test("refs need a snapshot and never silently remap", async () => {
  const { page } = setupPage();
  await assert.rejects(page.click({ ref: "e1" }), (error) => {
    assert.equal(error.code, "E_ELEMENT_NOT_FOUND");
    assert.match(error.details.hint, /no snapshot yet/);
    return true;
  });
  const snapshot = await page.snapshot();
  assert.deepEqual(snapshot.nodes.map((node) => node.ref), ["e1", "e2"]);
  assert.deepEqual(await page.click({ ref: "e1" }), { ok: true, x: 30, y: 30 });
  const second = await page.snapshot();
  assert.deepEqual(second.nodes.map((node) => node.ref), ["e3", "e4"]);
  await assert.rejects(page.click({ ref: "e1" }), (error) => {
    assert.equal(error.code, "E_ELEMENT_NOT_FOUND");
    assert.match(error.details.hint, /latest snapshot/);
    return true;
  });
});

test("navigate clears the snapshot so old refs fail loudly", async () => {
  const { page } = setupPage();
  await page.snapshot();
  await page.navigate("https://example.com/next");
  assert.equal(page.lastSnapshot, null);
  await assert.rejects(page.click({ ref: "e2" }), (error) => {
    assert.match(error.details.hint, /no snapshot yet/);
    return true;
  });
});

test("network capture records events across calls and is idempotent", async () => {
  const { page, transport } = setupPage();
  await page.startNetworkCapture();
  await page.startNetworkCapture();
  assert.equal(transport.count("Network.enable"), 1);
  transport.emit("Network.requestWillBeSent", { requestId: "r1", request: { url: "https://api.test/slow", method: "GET" }, type: "Fetch" });
  transport.emit("Network.responseReceived", { requestId: "r1", response: { status: 200, mimeType: "application/json", headers: { "content-type": "application/json" } } });
  const events = page.networkEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].url, "https://api.test/slow");
  assert.equal(events[0].status, 200);
  const withBodies = await page.networkBodies(events);
  assert.equal(withBodies[0].body, JSON.stringify({ value: 42 }));
  await page.stopNetworkCapture();
  assert.equal(transport.count("Network.disable"), 1);
  assert.equal(page.networkEvents().length, 1, "events survive stopNetworkCapture for later reads");
});

test("detach releases the session and its listeners", async () => {
  const { page, transport } = setupPage();
  await page.startNetworkCapture();
  assert.equal(transport.listenerCount("Network.requestWillBeSent"), 1);
  await page.detach();
  assert.equal(page.closed, true);
  assert.equal(transport.listenerCount("Network.requestWillBeSent"), 0);
  const detachCalls = transport.calls.filter((call) => call.method === "Target.detachFromTarget");
  assert.equal(detachCalls.length, 1);
  assert.equal(detachCalls[0].params.sessionId, "s1");
});

test("fill clears with key presses and inserts the value once", async () => {
  const { page, transport } = setupPage();
  const result = await page.fill({ selector: "#name", text: "harness" });
  assert.equal(result.ok, true);
  assert.equal(transport.count("Input.insertText"), 1);
  assert.equal(transport.count("Input.dispatchKeyEvent"), 4, "Ctrl+A and Backspace each send keyDown+keyUp");
  assert.equal(transport.calls.find((call) => call.method === "Input.insertText").params.text, "harness");
  assert.equal(transport.count("Runtime.callFunctionOn"), 1, "input/change are dispatched once");
  assert.equal(transport.calls.find((call) => call.method === "DOM.focus").params.backendNodeId, 5);
});

test("scroll sends wheel deltas from the viewport center", async () => {
  const { page, transport } = setupPage();
  transport.on("Runtime.evaluate", () => ({ result: { value: { cx: 400, cy: 300 } } }));
  await page.scroll({ dx: 5, dy: 400 });
  const scroll = transport.calls.find((call) => call.method === "Input.dispatchMouseEvent" && call.params.type === "mouseWheel");
  assert.equal(scroll.params.deltaX, 5);
  assert.equal(scroll.params.deltaY, 400);
  assert.equal(scroll.params.x, 400);
  assert.equal(scroll.params.y, 300);
});
