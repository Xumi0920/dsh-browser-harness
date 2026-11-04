import test from "node:test";
import assert from "node:assert/strict";
import { Page } from "../../dist/src/page.js";
import { join } from "node:path";
import { FakeTransport, quad } from "./helpers/fake-transport.js";
import { tempDir } from "../helpers/temp.js";

const AX_NODES = [
  { role: { value: "button" }, backendDOMNodeId: 10, name: { value: "Go" } },
  { role: { value: "link" }, backendDOMNodeId: 11, name: { value: "Docs" } },
];

function setupPage({ ax = AX_NODES, platform, dialogPolicy = "auto-dismiss" }: any = {}) {
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
    config: { dialogPolicy, focusEmulation: false, stateDir: "/tmp/bh-unit", downloadDir: "/tmp/bh-unit/downloads", platform },
  };
  const page = new Page(browser, { sessionId: "s1", targetId: "t1" });
  return { page, transport };
}

test("refs need a snapshot and never silently remap", async () => {
  const { page } = setupPage();
  await assert.rejects(page.click({ ref: "e1" }), (error: any) => {
    assert.equal(error.code, "E_ELEMENT_NOT_FOUND");
    assert.match(error.details.hint, /no snapshot yet/);
    return true;
  });
  const snapshot = await page.snapshot();
  assert.deepEqual(snapshot.nodes.map((node) => node.ref), ["e1", "e2"]);
  assert.deepEqual(await page.click({ ref: "e1" }), { ok: true, x: 30, y: 30 });
  const second = await page.snapshot();
  assert.deepEqual(second.nodes.map((node) => node.ref), ["e3", "e4"]);
  await assert.rejects(page.click({ ref: "e1" }), (error: any) => {
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
  await assert.rejects(page.click({ ref: "e2" }), (error: any) => {
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

test("networkBodies records per-response body errors", async () => {
  const { page, transport } = setupPage();
  await page.startNetworkCapture();
  transport.on("Network.getResponseBody", () => { throw new Error("No resource with given identifier"); });
  const withBodies = await page.networkBodies([{ requestId: "r1", url: "https://api.test/x", status: 200 }]);
  assert.match(withBodies[0].bodyError, /No resource/);
  assert.equal(withBodies[0].body, undefined);
});

test("fill returns only length/verified, never the entered value", async () => {
  const { page } = setupPage();
  const result = await page.fill({ selector: "#name", text: "secret-value" });
  assert.deepEqual(Object.keys(result).sort(), ["length", "ok"]);
  const verified = await page.fill({ selector: "#name", text: "secret-value" }, { verify: true });
  assert.equal(typeof verified.verified, "boolean");
  assert.equal("value" in verified, false);
});

test("screenshots stay inside screenshotDir and never overwrite", async () => {
  const transport = new FakeTransport();
  const png = Buffer.alloc(32);
  Buffer.from("89504e470d0a1a0a", "hex").copy(png, 0);
  png.writeUInt32BE(1, 16);
  png.writeUInt32BE(1, 20);
  transport.on("Page.captureScreenshot", () => ({ data: png.toString("base64") }));
  const dir = await tempDir("bh-page-shot-");
  const browser = {
    transport,
    config: { dialogPolicy: "auto-dismiss", focusEmulation: false, stateDir: dir, screenshotDir: dir },
  };
  const page = new Page(browser, { sessionId: "s1", targetId: "t1" });
  const shot = await page.screenshot({ path: "shot.png" });
  assert.equal(shot.path, join(dir, "shot.png"));
  await assert.rejects(page.screenshot({ path: "../escape.png" }), (error: any) => {
    assert.equal(error.code, "E_POLICY_DENIED");
    return true;
  });
  await assert.rejects(page.screenshot({ path: "shot.png" }), (error: any) => {
    assert.equal(error.code, "E_POLICY_DENIED");
    return true;
  });
});

test("fill uses Command+A on macOS and Control+A elsewhere", async () => {
  for (const [platform, expected] of [["darwin", 4], ["win32", 2], ["linux", 2]] as const) {
    const { page, transport } = setupPage({ platform });
    await page.fill({ selector: "#name", text: "mac" });
    const selectAll = transport.calls.find((call) => call.method === "Input.dispatchKeyEvent" && call.params.key === "a");
    assert.equal(selectAll.params.modifiers, expected, platform + " select-all modifier");
  }
});

test("hover moves the mouse over a selector", async () => {
  const { page, transport } = setupPage();
  const result = await page.hover({ selector: "#name" });
  assert.deepEqual(result, { ok: true, x: 30, y: 30 });
  const moved = transport.calls.filter((call) => call.method === "Input.dispatchMouseEvent" && call.params.type === "mouseMoved");
  assert.equal(moved.length, 1);
});

test("manual dialogs can be read and handled; auto-dismiss is recorded", async () => {
  const manual = setupPage({ dialogPolicy: "manual" });
  await manual.page.enableDomains();
  manual.transport.emit("Page.javascriptDialogOpening", { type: "confirm", message: "sure?" });
  assert.equal(manual.page.dialog().type, "confirm");
  await manual.page.handleDialog({ accept: true });
  assert.equal(manual.transport.count("Page.handleJavaScriptDialog"), 1);
  assert.equal(manual.transport.calls.find((call) => call.method === "Page.handleJavaScriptDialog").params.accept, true);
  await assert.rejects(manual.page.handleDialog(), (error: any) => {
    assert.equal(error.code, "E_BAD_ARG");
    return true;
  });

  const auto = setupPage();
  await auto.page.enableDomains();
  auto.transport.emit("Page.javascriptDialogOpening", { type: "alert", message: "hi" });
  assert.equal(auto.page.dialog(), null);
  assert.equal(auto.page.dialogHistory.length, 1);
});

test("console and Log events are captured for browser_extract", async () => {
  const { page, transport } = setupPage();
  await page.enableDomains();
  transport.emit("Runtime.consoleAPICalled", { type: "error", args: [{ value: "boom" }, { description: { x: 1 } }] });
  transport.emit("Log.entryAdded", { entry: { level: "warning", text: "careful", url: "https://example.com/app" } });
  const events = page.consoleEvents();
  assert.equal(events.length, 2);
  assert.equal(events[0].level, "error");
  assert.match(events[0].text, /boom/);
  assert.equal(events[1].level, "warning");
  assert.equal(events[1].text, "careful");
});

test("boxFor and element screenshots use the element clip", async () => {
  const { page, transport } = setupPage();
  const box = await page.boxFor({ selector: "#name" });
  assert.deepEqual(box, { x: 10, y: 20, width: 40, height: 20 });

  const dir = await tempDir("bh-page-element-shot-");
  const png = Buffer.alloc(32);
  Buffer.from("89504e470d0a1a0a", "hex").copy(png, 0);
  png.writeUInt32BE(1, 16);
  png.writeUInt32BE(1, 20);
  transport.on("Page.captureScreenshot", () => ({ data: png.toString("base64") }));
  const elementPage = new Page({
    transport,
    config: { dialogPolicy: "auto-dismiss", focusEmulation: false, stateDir: dir, screenshotDir: dir },
  }, { sessionId: "s1", targetId: "t1" });
  const shot = await elementPage.screenshot({ path: "element.png", clip: box });
  assert.ok(shot.path.endsWith("element.png"));
  const capture = transport.calls.filter((call) => call.method === "Page.captureScreenshot").at(-1);
  assert.deepEqual(capture.params.clip, { x: 10, y: 20, width: 40, height: 20, scale: 1 });
});

test("pdf exports to screenshotDir without overwriting", async () => {
  const dir = await tempDir("bh-page-pdf-");
  const transport = new FakeTransport();
  transport.on("Page.printToPDF", () => ({ data: Buffer.from("%PDF-1.4 test").toString("base64") }));
  const page = new Page({
    transport,
    config: { dialogPolicy: "auto-dismiss", focusEmulation: false, stateDir: dir, screenshotDir: dir },
  }, { sessionId: "s1", targetId: "t1" });
  const result = await page.pdf({ path: "page.pdf" });
  assert.ok(result.path.endsWith("page.pdf"));
  assert.ok(result.bytes > 0);
  await assert.rejects(page.pdf({ path: "page.pdf" }), (error: any) => {
    assert.equal(error.code, "E_POLICY_DENIED");
    return true;
  });
});

test("history back/forward/reload navigate through CDP history", async () => {
  const { page, transport } = setupPage();
  transport.on("Page.getNavigationHistory", () => ({
    currentIndex: 1,
    entries: [{ id: 1, url: "https://example.com/a" }, { id: 2, url: "https://example.com/b" }],
  }));
  transport.on("Runtime.evaluate", () => ({ result: { value: "complete" } }));
  await page.history("back");
  assert.equal(transport.calls.find((call) => call.method === "Page.navigateToHistoryEntry").params.entryId, 1);
  await page.history("reload");
  assert.equal(transport.count("Page.reload"), 1);
});

test("snapshot can target an iframe and highlight uses Overlay", async () => {
  const { page, transport } = setupPage();
  await page.snapshot({ frameId: "frame-1" });
  const axCall = transport.calls.filter((call) => call.method === "Accessibility.getFullAXTree").at(-1);
  assert.equal(axCall.params.frameId, "frame-1");
  await page.highlight({ selector: "#name" });
  const highlight = transport.calls.find((call) => call.method === "Overlay.highlightNode");
  assert.equal(highlight.params.backendNodeId, 5);
  assert.equal(highlight.params.highlightConfig.showInfo, true);
});

test("concurrent snapshots are serialized and old refs stay stale", async () => {
  const transport = new FakeTransport();
  let axCall = 0;
  transport.on("Accessibility.getFullAXTree", () => {
    axCall += 1;
    return { nodes: [{ role: { value: "button" }, backendDOMNodeId: axCall === 1 ? 10 : 20, name: { value: axCall === 1 ? "First" : "Second" } }] };
  });
  transport.on("DOM.getBoxModel", (params) => quad(params.backendNodeId === 10 ? 10 : 100, 20, 20, 20));
  const page = new Page({ transport, config: { dialogPolicy: "auto-dismiss", focusEmulation: false, stateDir: "/tmp/bh-unit" } }, { sessionId: "s1", targetId: "t1" });
  const [first, second] = await Promise.all([page.snapshot(), page.snapshot()]);
  assert.deepEqual(first.nodes.map((node) => node.ref), ["e1"]);
  assert.deepEqual(second.nodes.map((node) => node.ref), ["e2"]);
  assert.equal(second.nodes[0].backendDOMNodeId, 20);
  await assert.rejects(page.click({ ref: first.nodes[0].ref }), (error) => {
    assert.equal(error.code, "E_ELEMENT_NOT_FOUND");
    return true;
  });
});

test("snapshot role/name filtering happens before the node cap", async () => {
  const transport = new FakeTransport();
  const nodes = Array.from({ length: 450 }, (_, index) => ({ role: { value: "button" }, backendDOMNodeId: 100 + index, name: { value: "button-" + (index + 1) } }));
  transport.on("Accessibility.getFullAXTree", () => ({ nodes }));
  transport.on("DOM.getBoxModel", () => quad(1, 1, 10, 10));
  const page = new Page({ transport, config: { dialogPolicy: "auto-dismiss", focusEmulation: false, stateDir: "/tmp/bh-unit" } }, { sessionId: "s1", targetId: "t1" });
  const snapshot = await page.snapshot({ maxNodes: 250, role: "button", name: "button-450" });
  assert.equal(snapshot.nodes.length, 1);
  assert.equal(snapshot.nodes[0].name, "button-450");
});

test("click rejects a covered target unless force is set", async () => {
  const { page, transport } = setupPage();
  await page.snapshot();
  transport.on("Runtime.callFunctionOn", () => ({ result: { value: { ok: false, reason: "covered", hit: { tag: "div", id: "overlay" } } } }));
  await assert.rejects(page.click({ ref: "e1" }), (error) => {
    assert.equal(error.code, "E_CLICK_INTERCEPTED");
    assert.equal(error.details.hit.id, "overlay");
    return true;
  });
  const forced = await page.click({ ref: "e1" }, { force: true });
  assert.equal(forced.ok, true);
});

test("waitUntil load waits for complete, not interactive", async () => {
  const { page, transport } = setupPage();
  const states = ["interactive", "interactive", "complete"];
  transport.on("Runtime.evaluate", () => ({ result: { value: states.shift() || "complete" } }));
  const result = await page.waitForLoad({ waitUntil: "load", timeoutMs: 1_000 });
  assert.equal(result.readyState, "complete");
  assert.equal(result.waitedFor, "load");
});

test("network idle does not treat a capped log as idle while requests are active", async () => {
  const transport = new FakeTransport();
  const page = new Page({ transport, config: { dialogPolicy: "auto-dismiss", focusEmulation: false, stateDir: "/tmp/bh-unit" } }, { sessionId: "s1", targetId: "t1" });
  await page.startNetworkCapture({ maxEvents: 5 });
  transport.emit("Network.requestWillBeSent", { requestId: "r1", request: { url: "https://example.test/slow" }, type: "Fetch" });
  await assert.rejects(page.waitForNetworkIdle({ timeoutMs: 150, idleMs: 30 }), (error) => {
    assert.equal(error.code, "E_TIMEOUT");
    return true;
  });
  transport.emit("Network.loadingFinished", { requestId: "r1" });
  const idle = await page.waitForNetworkIdle({ timeoutMs: 500, idleMs: 30 });
  assert.equal(idle.activeRequests, 0);
});

test("drag dispatches a real mouse sequence from source to target", async () => {
  const { page, transport } = setupPage();
  await page.snapshot();
  const result = await page.drag({ ref: "e2" }, { selector: "#drop" }, { steps: 4 });
  assert.equal(result.ok, true);
  assert.equal(result.steps, 4);
  assert.equal(transport.count("Input.dispatchMouseEvent"), 7);
  const pressed = transport.calls.find((call) => call.method === "Input.dispatchMouseEvent" && call.params.type === "mousePressed");
  const released = transport.calls.find((call) => call.method === "Input.dispatchMouseEvent" && call.params.type === "mouseReleased");
  assert.ok(pressed && released);
});

test("snapshot offset paginates beyond 400 and keeps filtered totals", async () => {
  const transport = new FakeTransport();
  const nodes = Array.from({ length: 450 }, (_, index) => ({ role: { value: "button" }, backendDOMNodeId: 100 + index, name: { value: "button-" + (index + 1) } }));
  transport.on("Accessibility.getFullAXTree", () => ({ nodes }));
  transport.on("DOM.getBoxModel", () => quad(1, 1, 10, 10));
  const page = new Page({ transport, config: { dialogPolicy: "auto-dismiss", focusEmulation: false, stateDir: "/tmp/bh-unit" } }, { sessionId: "s1", targetId: "t1" });
  const snapshot = await page.snapshot({ maxNodes: 50, offset: 400 });
  assert.equal(snapshot.total, 450);
  assert.equal(snapshot.nodes.length, 50);
  assert.equal(snapshot.nodes[0].name, "button-401");
  assert.equal(snapshot.nodes.at(-1).name, "button-450");
  assert.deepEqual(snapshot.nodes.map((node) => node.ref).slice(0, 2), ["e401", "e402"]);
  assert.equal(snapshot.truncated, false);
});

test("snapshot generation reuses the cached AX tree and rejects stale generations", async () => {
  const transport = new FakeTransport();
  const nodes = Array.from({ length: 450 }, (_, index) => ({ role: { value: "button" }, backendDOMNodeId: 100 + index, name: { value: "button-" + (index + 1) } }));
  transport.on("Accessibility.getFullAXTree", () => ({ nodes }));
  transport.on("DOM.getBoxModel", () => quad(1, 1, 10, 10));
  const page = new Page({ transport, config: { dialogPolicy: "auto-dismiss", focusEmulation: false, stateDir: "/tmp/bh-unit" } }, { sessionId: "s1", targetId: "t1" });
  const first = await page.snapshot({ maxNodes: 2, offset: 0 });
  assert.equal(first.generation, "1");
  assert.deepEqual(first.nodes.map((node) => node.ref), ["e1", "e2"]);
  const second = await page.snapshot({ maxNodes: 50, offset: 400, generation: first.generation });
  assert.equal(second.generation, first.generation);
  assert.equal(second.snapshotVersion, first.snapshotVersion);
  assert.equal(second.total, 450);
  assert.equal(second.nodes[0].name, "button-401");
  assert.deepEqual(second.nodes.slice(0, 2).map((node) => node.ref), ["e401", "e402"]);
  const next = await page.snapshot({ maxNodes: 2, offset: 0 });
  assert.notEqual(next.generation, first.generation);
  await assert.rejects(page.snapshot({ maxNodes: 2, generation: first.generation }), (error) => {
    assert.equal(error.code, "E_STALE_SNAPSHOT");
    return true;
  });
});
