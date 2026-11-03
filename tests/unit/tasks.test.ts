import test from "node:test";
import assert from "node:assert/strict";
import { TabLockManager, defaultTaskRecord, normalizeTask } from "../../dist/src/tasks.js";

test("tab leases are exclusive per task and reentrant for the same task", async () => {
  const locks = new TabLockManager({ timeoutMs: 100 });
  const first = await locks.acquire("T1", "task-a", { timeoutMs: 0 });
  const nested = await locks.acquire("T1", "task-a", { timeoutMs: 0 });
  assert.equal(locks.heldBy("T1").depth, 2);
  await assert.rejects(locks.acquire("T1", "task-b", { timeoutMs: 10 }), (error) => {
    assert.equal(error.code, "E_LOCK_TIMEOUT");
    return true;
  });
  await nested.release();
  assert.equal(locks.heldBy("T1").depth, 1);
  await first.release();
  assert.equal(locks.heldBy("T1"), null);
  const second = await locks.acquire("T1", "task-b", { timeoutMs: 0 });
  await second.release();
});

test("task locks can be released wholesale for pause/close", async () => {
  const locks = new TabLockManager({ timeoutMs: 100 });
  const lease = await locks.acquire("T1", "task-a", { timeoutMs: 0 });
  await locks.releaseTask("task-a");
  assert.equal(locks.heldBy("T1"), null);
  await lease.release();
});

test("task records normalize defaults and cleanup policy", () => {
  assert.deepEqual(defaultTaskRecord("lane").state, "active");
  const task = normalizeTask({ state: "paused", cleanupPolicy: "leave" }, "lane");
  assert.equal(task.state, "paused");
  assert.equal(task.cleanupPolicy, "leave");
  assert.equal(task.id, "lane");
  assert.deepEqual(normalizeTask({ state: "bogus" }, "x").state, "active");
});
