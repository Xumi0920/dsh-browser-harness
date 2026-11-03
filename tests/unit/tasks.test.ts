import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TabLockManager, defaultTaskRecord, normalizeTask } from "../../dist/src/tasks.js";
import { cleanupTempDirs, tempDir } from "../helpers/temp.js";

after(cleanupTempDirs);

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

test("file leases are shared across managers and recover stale files", async () => {
  const dir = await tempDir("bh-file-lease-");
  const a = new TabLockManager({ timeoutMs: 100, fileLease: true, fileDir: dir, heartbeatMs: 100, staleMs: 5_000 });
  const b = new TabLockManager({ timeoutMs: 100, fileLease: true, fileDir: dir, heartbeatMs: 100, staleMs: 5_000 });
  const first = await a.acquire("T1", "task-a", { timeoutMs: 0 });
  await assert.rejects(b.acquire("T1", "task-b", { timeoutMs: 30 }), (error) => {
    assert.equal(error.code, "E_LOCK_TIMEOUT");
    return true;
  });
  await first.release();
  const second = await b.acquire("T1", "task-b", { timeoutMs: 100 });
  await second.release();

  const staleFile = join(dir, createHash("sha256").update("T2").digest("hex") + ".json");
  await writeFile(staleFile, JSON.stringify({
    version: 1,
    targetId: "T2",
    taskId: "dead-task",
    token: "dead-token",
    pid: 999999,
    hostname: hostname(),
    acquiredAt: new Date(Date.now() - 60_000).toISOString(),
    heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
  }));
  const recovered = await b.acquire("T2", "task-b", { timeoutMs: 500 });
  assert.equal(recovered.targetId, "T2");
  await recovered.release();
});

test("task records normalize defaults and cleanup policy", () => {
  assert.deepEqual(defaultTaskRecord("lane").state, "active");
  const task = normalizeTask({ state: "paused", cleanupPolicy: "leave" }, "lane");
  assert.equal(task.state, "paused");
  assert.equal(task.cleanupPolicy, "leave");
  assert.equal(task.id, "lane");
  assert.deepEqual(normalizeTask({ state: "bogus" }, "x").state, "active");
});
