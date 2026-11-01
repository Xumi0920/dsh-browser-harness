import test from "node:test";
import assert from "node:assert/strict";
import { CDPTransport } from "../../dist/src/cdp/transport.js";
import { FakeWebSocket } from "./helpers/fake-websocket.js";

test.beforeEach(() => FakeWebSocket.reset());

function makeTransport(options = {}) {
  return new CDPTransport("ws://127.0.0.1:9331/devtools/browser/fake", {
    WebSocketImpl: FakeWebSocket,
    defaultTimeoutMs: 100,
    ...options,
  });
}

test("connect resolves on open and drops a second connect call", async () => {
  const tr = makeTransport();
  await tr.connect();
  assert.equal(tr.ready, true);
  await assert.rejects(tr.connect(), /connect\(\) called twice/);
  tr.close();
});

test("send matches responses by id and resolves the result", async () => {
  FakeWebSocket.script = (ws, message) => {
    setTimeout(() => ws.deliver({ id: message.id, result: { product: "Chrome/156" } }), 5);
  };
  const tr = makeTransport();
  await tr.connect();
  const result = await tr.send("Browser.getVersion");
  assert.deepEqual(result, { product: "Chrome/156" });
  assert.equal(FakeWebSocket.instances[0].sent[0].method, "Browser.getVersion");
  tr.close();
});

test("concurrent commands resolve independently", async () => {
  FakeWebSocket.script = (ws, message) => {
    const delay = message.method === "a" ? 10 : 1;
    setTimeout(() => ws.deliver({ id: message.id, result: { which: message.method } }), delay);
  };
  const tr = makeTransport();
  await tr.connect();
  const [a, b] = await Promise.all([tr.send("a"), tr.send("b")]);
  assert.deepEqual(a, { which: "a" });
  assert.deepEqual(b, { which: "b" });
  tr.close();
});

test("CDP error responses reject with E_CDP and keep the method", async () => {
  FakeWebSocket.script = (ws, message) => {
    setTimeout(() => ws.deliver({ id: message.id, error: { code: -32601, message: "method not found" } }), 1);
  };
  const tr = makeTransport();
  await tr.connect();
  await assert.rejects(tr.send("Nope.method"), (error: any) => {
    assert.equal(error.code, "E_CDP");
    assert.match(error.message, /Nope\.method/);
    return true;
  });
  tr.close();
});

test("timeouts reject with E_TIMEOUT and drop the pending entry", async () => {
  const tr = makeTransport({ defaultTimeoutMs: 20 });
  await tr.connect();
  await assert.rejects(tr.send("Slow.method"), (error: any) => {
    assert.equal(error.code, "E_TIMEOUT");
    assert.match(error.message, /timed out after 20ms/);
    return true;
  });
  assert.equal(tr.pending.size, 0);
  tr.close();
});

test("events dispatch to listeners and waitForEvent resolves on predicate", async () => {
  const tr = makeTransport();
  await tr.connect();
  const ws = FakeWebSocket.instances[0];
  setTimeout(() => ws.deliver({ method: "Page.loadEventFired", params: { timestamp: 1 } }), 1);
  const seen = [];
  tr.onEvent("Page.loadEventFired", (params) => seen.push(params));
  const { params } = await tr.waitForEvent("Page.loadEventFired", (p) => p.timestamp === 1, 50);
  assert.deepEqual(params, { timestamp: 1 });
  assert.equal(seen.length, 1);
  tr.close();
});

test("waitForEvent timeout reports the event name", async () => {
  const tr = makeTransport({ defaultTimeoutMs: 15 });
  await tr.connect();
  await assert.rejects(tr.waitForEvent("Never.happens", undefined, 15), /Never\.happens/);
  tr.close();
});

test("close rejects pending commands and further sends", async () => {
  const tr = makeTransport({ defaultTimeoutMs: 1000 });
  await tr.connect();
  const pending = tr.send("Hangs.forever");
  tr.close();
  await assert.rejects(pending, (error: any) => {
    assert.equal(error.code, "E_NOT_CONNECTED");
    return true;
  });
  await assert.rejects(tr.send("After.close"), (error: any) => {
    assert.equal(error.code, "E_NOT_CONNECTED");
    return true;
  });
});

test("session-scoped commands carry sessionId", async () => {
  FakeWebSocket.script = (ws, message) => {
    setTimeout(() => ws.deliver({ id: message.id, sessionId: message.sessionId, result: {} }), 1);
  };
  const tr = makeTransport();
  await tr.connect();
  await tr.send("Page.enable", {}, { sessionId: "S1" });
  assert.equal(FakeWebSocket.instances[0].sent[0].sessionId, "S1");
  tr.close();
});

test("malformed frames are ignored instead of crashing", async () => {
  const tr = makeTransport();
  await tr.connect();
  FakeWebSocket.instances[0].deliver({ id: 999, result: {} });
  FakeWebSocket.instances[0].deliver({ method: "X.y" });
  assert.equal(tr.pending.size, 0);
  tr.close();
});
