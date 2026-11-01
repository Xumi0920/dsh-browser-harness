import test from "node:test";
import assert from "node:assert/strict";
import { MAX_SNAPSHOT_TEXT_LINES, boxCenter, buildSnapshot, findByRole, findRef, formatSnapshot, snapshotToText } from "../../src/ax.mjs";

const nodes = [
  { role: { value: "RootWebArea" }, ignored: false, backendDOMNodeId: 1, name: { value: "Demo" } },
  { role: { value: "button" }, ignored: false, backendDOMNodeId: 10, name: { value: "Sign in" } },
  { role: { value: "textbox" }, ignored: false, backendDOMNodeId: 11, name: { value: "Email" }, value: { value: "a@b.c" } },
  { role: { value: "StaticText" }, ignored: false, backendDOMNodeId: 12, name: { value: "hello" } },
  { role: { value: "button" }, ignored: true, backendDOMNodeId: 13, name: { value: "Ignored" } },
  { role: { value: "link" }, ignored: false, backendDOMNodeId: 14, name: { value: "Docs" }, properties: [{ name: "disabled", value: { value: true } }] },
  { role: { value: "button" }, ignored: false, name: { value: "No backend id" } },
];

const boxes = new Map([
  [10, { content: [100, 200, 180, 200, 180, 240, 100, 240] }],
]);

test("boxCenter averages the quad corners", () => {
  assert.deepEqual(boxCenter({ content: [0, 0, 100, 0, 100, 50, 0, 50] }), { x: 50, y: 25, width: 100, height: 50 });
  assert.equal(boxCenter({}), null);
});

test("snapshot keeps interactive roles, drops ignored and id-less nodes, assigns refs", () => {
  const snapshot = buildSnapshot(nodes, { boxes });
  assert.deepEqual(snapshot.nodes.map((n) => n.ref), ["e1", "e2", "e3"]);
  assert.deepEqual(snapshot.nodes.map((n) => n.role), ["button", "textbox", "link"]);
  assert.equal(snapshot.total, 3);
  assert.equal(snapshot.truncated, false);
  const button = snapshot.nodes[0];
  assert.equal(button.name, "Sign in");
  assert.deepEqual(button.center, { x: 140, y: 220 });
  assert.deepEqual(button.size, { width: 80, height: 40 });
  assert.equal(snapshot.nodes[1].value, "a@b.c");
  assert.equal(snapshot.nodes[2].disabled, true);
});

test("snapshot truncates at maxNodes and reports it", () => {
  const snapshot = buildSnapshot(nodes, { maxNodes: 1, boxes });
  assert.equal(snapshot.nodes.length, 1);
  assert.equal(snapshot.total, 3);
  assert.equal(snapshot.truncated, true);
});

test("refStart keeps refs monotonic across snapshots", () => {
  const snapshot = buildSnapshot(nodes, { boxes, refStart: 10 });
  assert.deepEqual(snapshot.nodes.map((node) => node.ref), ["e11", "e12", "e13"]);
});

test("includeText adds static text roles", () => {
  const snapshot = buildSnapshot(nodes, { includeText: true });
  assert.ok(snapshot.nodes.some((node) => node.role === "StaticText"));
});

test("findRef and findByRole work on a snapshot", () => {
  const snapshot = buildSnapshot(nodes, { boxes });
  assert.equal(findRef(snapshot.nodes, "e2").name, "Email");
  assert.equal(findRef(snapshot.nodes, "e9"), null);
  assert.equal(findByRole(snapshot.nodes, { role: "button" }).length, 1);
  assert.equal(findByRole(snapshot.nodes, { name: "mail" }).length, 1);
  assert.equal(findByRole(snapshot.nodes, { name: "Docs", exact: true }).length, 1);
});

test("snapshotToText renders compact lines", () => {
  const text = snapshotToText(buildSnapshot(nodes, { boxes }));
  assert.match(text, /e1 button "Sign in" @140,220/);
  assert.match(text, /e2 textbox "Email" value="a@b.c"/);
});

test("formatSnapshot reports the true truncation state", () => {
  const nodes = Array.from({ length: 250 }, (_, index) => ({ ref: "e" + (index + 1), role: "button", name: "B" + index }));
  const rendered = formatSnapshot({ nodes, truncated: false, total: 250 });
  assert.equal(rendered.truncated, true);
  assert.equal(rendered.shown, MAX_SNAPSHOT_TEXT_LINES);
  assert.match(rendered.text, /snapshot truncated \(200 of 250 nodes\)/);
  assert.equal(snapshotToText({ nodes, truncated: false, total: 250 }), rendered.text);

  const small = formatSnapshot({ nodes: nodes.slice(0, 3), truncated: false });
  assert.equal(small.truncated, false);
  assert.doesNotMatch(small.text, /truncated/);

  const axCapped = formatSnapshot({ nodes: nodes.slice(0, 3), truncated: true, total: 250 });
  assert.equal(axCapped.truncated, true);
  assert.match(axCapped.text, /truncated \(3 of 250 nodes\)/);
});
