import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MARKER,
  emptyState,
  forgetTab,
  readState,
  rememberOwnedTab,
  setCurrent,
  setGroup,
  statePath,
  updateState,
  writeState,
} from "../../dist/src/state.js";

async function freshDir() {
  return tempDir("bh-state-");
}
import { cleanupTempDirs, tempDir } from "../helpers/temp.mjs";


after(cleanupTempDirs);

test("missing state reads as empty", async () => {
  const dir = await freshDir();
  const state = await readState("default", dir);
  assert.equal(state.version, 1);
  assert.equal(state.current, null);
  assert.deepEqual(state.ownedTabs, []);
  assert.equal(state.marker, DEFAULT_MARKER);
});

test("writeState is atomic and round-trips, adding updatedAt", async () => {
  const dir = await freshDir();
  const written = await writeState({ ...emptyState(), current: { targetId: "T1", url: "https://example.com" } }, "default", dir);
  assert.ok(written.updatedAt);
  const state = await readState("default", dir);
  assert.equal(state.current.targetId, "T1");
  const raw = await readFile(statePath("default", dir), "utf8");
  assert.ok(raw.includes('"targetId": "T1"'));
});

test("corrupt state file falls back to empty state", async () => {
  const dir = await freshDir();
  await writeFile(statePath("default", dir), "{not json", "utf8");
  const state = await readState("default", dir);
  assert.equal(state.current, null);
});

test("updateState serializes read-modify-write with the lane lock", async () => {
  const dir = await freshDir();
  await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      updateState("default", (state) => {
        const count = (state.count || 0) + 1;
        return { ...state, count, last: index };
      }, dir)),
  );
  const state = await readState("default", dir);
  assert.equal(state.count, 5);
});

test("owned tabs are remembered once and forgotten", async () => {
  const dir = await freshDir();
  await rememberOwnedTab("default", { targetId: "T1", url: "https://a.example" }, dir);
  await rememberOwnedTab("default", { targetId: "T1", url: "https://a.example" }, dir);
  await rememberOwnedTab("default", { targetId: "T2", url: "https://b.example" }, dir);
  let state = await readState("default", dir);
  assert.equal(state.ownedTabs.length, 2);
  await setCurrent("default", { targetId: "T1", url: "https://a.example" }, dir);
  await forgetTab("default", "T1", dir);
  state = await readState("default", dir);
  assert.equal(state.current, null);
  assert.deepEqual(state.ownedTabs.map((tab) => tab.targetId), ["T2"]);
});

test("lanes are isolated and lane names are sanitized", async () => {
  const dir = await freshDir();
  await writeState({ ...emptyState(), count: 1 }, "a", dir);
  await writeState({ ...emptyState(), count: 2 }, "b", dir);
  assert.equal((await readState("a", dir)).count, 1);
  assert.equal((await readState("b", dir)).count, 2);
  assert.match(statePath("../../evil lane", dir), /state-evil-lane\.json$/);
});

test("tab groups are remembered per lane and invalid groups are dropped", async () => {
  const dir = await freshDir();
  const written = await setGroup("default", { id: 42, title: "DSH · task", color: "blue" }, dir);
  assert.equal(written.group.id, 42);
  const state = await readState("default", dir);
  assert.deepEqual({ id: state.group.id, title: state.group.title, color: state.group.color }, { id: 42, title: "DSH · task", color: "blue" });
  assert.ok(state.group.updatedAt);
  await writeState({ ...emptyState(), group: { id: "not-a-number" } }, "default", dir);
  assert.equal((await readState("default", dir)).group, null);
  await setGroup("default", null, dir);
  assert.equal((await readState("default", dir)).group, null);
});