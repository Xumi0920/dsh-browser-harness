/**
 * In-process tab leases and task records for multi-session safety.
 *
 * Locks are intentionally memory-only: a restarted manager starts with an
 * empty lock table, while durable task metadata lives in the per-lane state
 * file. Cross-process locking is a later phase.
 */

import { randomUUID } from "node:crypto";
import { HarnessError, codes } from "./errors.js";

export type TaskState = "active" | "paused" | "closing" | "closed";

export interface TaskRecord {
  id: string;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  cleanupPolicy: "close-owned" | "leave";
}

interface HeldLock {
  targetId: string;
  taskId: string;
  tokens: string[];
  acquiredAt: number;
}

export interface TabLease {
  targetId: string;
  taskId: string;
  token: string;
  release(): Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class TabLockManager {
  locks: Map<string, HeldLock>;
  timeoutMs: number;

  constructor({ timeoutMs = 5000 }: any = {} as any) {
    this.locks = new Map();
    this.timeoutMs = timeoutMs;
  }

  snapshot() {
    return [...this.locks.values()].map((lock) => ({
      targetId: lock.targetId,
      taskId: lock.taskId,
      depth: lock.tokens.length,
      acquiredAt: new Date(lock.acquiredAt).toISOString(),
    }));
  }

  heldBy(targetId: any) {
    const lock = this.locks.get(String(targetId));
    return lock ? { taskId: lock.taskId, depth: lock.tokens.length, acquiredAt: new Date(lock.acquiredAt).toISOString() } : null;
  }

  taskLocks(taskId: any) {
    return this.snapshot().filter((lock) => lock.taskId === String(taskId));
  }

  async acquire(targetId: any, taskId: any, { timeoutMs = this.timeoutMs }: any = {} as any): Promise<TabLease> {
    const key = String(targetId);
    const owner = String(taskId);
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    for (;;) {
      const existing = this.locks.get(key);
      if (!existing) {
        const token = randomUUID();
        const lock: HeldLock = { targetId: key, taskId: owner, tokens: [token], acquiredAt: Date.now() };
        this.locks.set(key, lock);
        return this.#lease(lock, token);
      }
      if (existing.taskId === owner) {
        const token = randomUUID();
        existing.tokens.push(token);
        return this.#lease(existing, token);
      }
      if (Date.now() >= deadline) {
        if (Number(timeoutMs) === 0) {
          throw new HarnessError(codes.E_TAB_LOCKED, "tab " + key + " is locked by task " + existing.taskId, { details: { targetId: key, ownerTaskId: existing.taskId } });
        }
        throw new HarnessError(codes.E_LOCK_TIMEOUT, "timed out waiting for tab " + key + " locked by task " + existing.taskId, {
          details: { targetId: key, ownerTaskId: existing.taskId, timeoutMs },
        });
      }
      await sleep(25);
    }
  }

  #lease(lock: HeldLock, token: string): TabLease {
    let released = false;
    return {
      targetId: lock.targetId,
      taskId: lock.taskId,
      token,
      release: async () => {
        if (released) return;
        released = true;
        this.#release(lock, token);
      },
    };
  }

  #release(lock: HeldLock, token: string) {
    const current = this.locks.get(lock.targetId);
    if (current !== lock) return;
    const index = lock.tokens.indexOf(token);
    if (index >= 0) lock.tokens.splice(index, 1);
    if (lock.tokens.length === 0) this.locks.delete(lock.targetId);
  }

  clear() {
    this.locks.clear();
  }

  async releaseTask(taskId: any) {
    for (const [targetId, lock] of [...this.locks.entries()]) {
      if (lock.taskId === String(taskId)) this.locks.delete(targetId);
    }
  }
}

export function defaultTaskRecord(id: string): TaskRecord {
  const now = new Date().toISOString();
  return { id, state: "active", createdAt: now, updatedAt: now, cleanupPolicy: "close-owned" };
}

export function normalizeTask(value: any, id: string): TaskRecord {
  const base = defaultTaskRecord(id);
  if (!value || typeof value !== "object") return base;
  const state = ["active", "paused", "closing", "closed"].includes(value.state) ? value.state : "active";
  return {
    ...base,
    ...value,
    id,
    state,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : base.createdAt,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : base.updatedAt,
    cleanupPolicy: value.cleanupPolicy === "leave" ? "leave" : "close-owned",
  };
}
