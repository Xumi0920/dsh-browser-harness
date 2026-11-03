/**
 * In-process tab leases plus optional cross-manager file leases.
 *
 * The in-memory table is the fast path; when fileLease is enabled the same
 * lease is also represented by an atomically-created file under
 * <stateDir>/locks, with heartbeat and stale recovery for crashed processes.
 */

import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HarnessError, codes } from "./errors.js";

export type TaskState = "active" | "paused" | "closing" | "closed";

export interface TaskRecord {
  id: string;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  cleanupPolicy: "close-owned" | "leave";
  browserContextId?: string | null;
}

interface HeldLock {
  targetId: string;
  taskId: string;
  tokens: string[];
  acquiredAt: number;
  filePath?: string;
  fileToken?: string;
  heartbeat?: any;
}

export interface TabLease {
  targetId: string;
  taskId: string;
  token: string;
  release(): Promise<void>;
}

interface FileLeasePayload {
  version: 1;
  targetId: string;
  taskId: string;
  token: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
  heartbeatAt: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function leasePath(dir: string, targetId: string) {
  return join(dir, createHash("sha256").update(String(targetId)).digest("hex") + ".json");
}

function pidAlive(pid: number) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error && error.code === "EPERM";
  }
}

export class TabLockManager {
  locks: Map<string, HeldLock>;
  timeoutMs: number;
  fileLease: boolean;
  fileDir: string | null;
  heartbeatMs: number;
  staleMs: number;

  constructor({ timeoutMs = 5000, fileLease = false, fileDir = null, heartbeatMs = 5000, staleMs = 30000 }: any = {} as any) {
    this.locks = new Map();
    this.timeoutMs = timeoutMs;
    this.fileLease = Boolean(fileLease);
    this.fileDir = fileDir || null;
    this.heartbeatMs = heartbeatMs;
    this.staleMs = staleMs;
  }

  configureFileLease({ fileLease = this.fileLease, fileDir = this.fileDir, heartbeatMs = this.heartbeatMs, staleMs = this.staleMs }: any = {} as any) {
    this.fileLease = Boolean(fileLease) && Boolean(fileDir);
    this.fileDir = fileDir || null;
    this.heartbeatMs = heartbeatMs;
    this.staleMs = staleMs;
  }

  snapshot() {
    return [...this.locks.values()].map((lock) => ({
      targetId: lock.targetId,
      taskId: lock.taskId,
      depth: lock.tokens.length,
      acquiredAt: new Date(lock.acquiredAt).toISOString(),
      fileLease: Boolean(lock.filePath),
    }));
  }

  heldBy(targetId: any) {
    const lock = this.locks.get(String(targetId));
    return lock ? { taskId: lock.taskId, depth: lock.tokens.length, acquiredAt: new Date(lock.acquiredAt).toISOString(), fileLease: Boolean(lock.filePath) } : null;
  }

  taskLocks(taskId: any) {
    return this.snapshot().filter((lock) => lock.taskId === String(taskId));
  }

  async acquire(targetId: any, taskId: any, { timeoutMs = this.timeoutMs }: any = {} as any): Promise<TabLease> {
    const key = String(targetId);
    const owner = String(taskId);
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    let lastOwner: string | null = null;
    for (;;) {
      const existing = this.locks.get(key);
      if (existing) {
        if (existing.taskId === owner) {
          const token = randomUUID();
          existing.tokens.push(token);
          return this.#lease(existing, token);
        }
        lastOwner = existing.taskId;
        if (Date.now() >= deadline) throw this.#timeoutError(key, lastOwner, timeoutMs);
        await sleep(25);
        continue;
      }
      if (this.fileLease && this.fileDir) {
        const file = leasePath(this.fileDir, key);
        const token = randomUUID();
        const payload: FileLeasePayload = {
          version: 1,
          targetId: key,
          taskId: owner,
          token,
          pid: process.pid,
          hostname: hostname(),
          acquiredAt: new Date().toISOString(),
          heartbeatAt: new Date().toISOString(),
        };
        try {
          await mkdir(this.fileDir, { recursive: true, mode: 0o700 });
          await writeFile(file, JSON.stringify(payload), { encoding: "utf8", flag: "wx", mode: 0o600 });
          const lock: HeldLock = { targetId: key, taskId: owner, tokens: [token], acquiredAt: Date.now(), filePath: file, fileToken: token };
          lock.heartbeat = setInterval(() => { this.#heartbeat(lock).catch(() => {}); }, this.heartbeatMs);
          lock.heartbeat.unref?.();
          this.locks.set(key, lock);
          return this.#lease(lock, token);
        } catch (error: any) {
          if (!error || error.code !== "EEXIST") {
            throw new HarnessError("E_LEASE_FAILED", "cannot acquire file lease for tab " + key + ": " + String(error && error.message || error), { cause: error, details: { targetId: key, fileDir: this.fileDir } });
          }
          const ownerInfo = await this.#readLease(file);
          lastOwner = ownerInfo ? ownerInfo.taskId : "unknown";
          if (ownerInfo && await this.#isStale(ownerInfo, file)) {
            await this.#removeStale(file, ownerInfo.token);
            continue;
          }
        }
      } else {
        const token = randomUUID();
        const lock: HeldLock = { targetId: key, taskId: owner, tokens: [token], acquiredAt: Date.now() };
        this.locks.set(key, lock);
        return this.#lease(lock, token);
      }
      if (Date.now() >= deadline) throw this.#timeoutError(key, lastOwner, timeoutMs);
      await sleep(25);
    }
  }

  #timeoutError(targetId: string, owner: string | null, timeoutMs: number) {
    if (Number(timeoutMs) === 0) {
      return new HarnessError(codes.E_TAB_LOCKED, "tab " + targetId + " is locked by task " + (owner || "another process"), { details: { targetId, ownerTaskId: owner } });
    }
    return new HarnessError(codes.E_LOCK_TIMEOUT, "timed out waiting for tab " + targetId + " locked by " + (owner || "another process"), {
      details: { targetId, ownerTaskId: owner, timeoutMs },
    });
  }

  async #readLease(file: string): Promise<FileLeasePayload | null> {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch {
      return null;
    }
  }

  async #isStale(payload: FileLeasePayload, file: string) {
    const heartbeat = Date.parse(payload.heartbeatAt || payload.acquiredAt);
    if (Number.isFinite(heartbeat) && Date.now() - heartbeat > this.staleMs) return true;
    if (payload.hostname === hostname() && payload.pid && !pidAlive(payload.pid)) return true;
    // Invalid/old files without a parseable heartbeat are stale by age.
    if (!Number.isFinite(heartbeat)) {
      try {
        const { stat } = await import("node:fs/promises");
        const info = await stat(file);
        return Date.now() - info.mtimeMs > this.staleMs;
      } catch {
        return false;
      }
    }
    return false;
  }

  async #removeStale(file: string, expectedToken: string) {
    const current = await this.#readLease(file);
    if (!current || current.token !== expectedToken) return;
    await unlink(file).catch(() => {});
  }

  async #heartbeat(lock: HeldLock) {
    if (!lock.filePath || !lock.fileToken) return;
    const current = await this.#readLease(lock.filePath);
    if (!current || current.token !== lock.fileToken) {
      if (lock.heartbeat) clearInterval(lock.heartbeat);
      return;
    }
    current.heartbeatAt = new Date().toISOString();
    const tmp = lock.filePath + "." + process.pid + "." + Date.now() + ".tmp";
    await writeFile(tmp, JSON.stringify(current), { encoding: "utf8", mode: 0o600 });
    await rename(tmp, lock.filePath);
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
        await this.#release(lock, token);
      },
    };
  }

  async #release(lock: HeldLock, token: string) {
    const current = this.locks.get(lock.targetId);
    if (current !== lock) return;
    const index = lock.tokens.indexOf(token);
    if (index >= 0) lock.tokens.splice(index, 1);
    if (lock.tokens.length > 0) return;
    if (lock.heartbeat) clearInterval(lock.heartbeat);
    this.locks.delete(lock.targetId);
    if (lock.filePath && lock.fileToken) {
      const fileLease = await this.#readLease(lock.filePath);
      if (fileLease && fileLease.token === lock.fileToken) await unlink(lock.filePath).catch(() => {});
    }
  }

  async releaseTask(taskId: any) {
    for (const [targetId, lock] of [...this.locks.entries()]) {
      if (lock.taskId !== String(taskId)) continue;
      if (lock.heartbeat) clearInterval(lock.heartbeat);
      this.locks.delete(targetId);
      if (lock.filePath && lock.fileToken) {
        const fileLease = await this.#readLease(lock.filePath);
        if (fileLease && fileLease.token === lock.fileToken) await unlink(lock.filePath).catch(() => {});
      }
    }
  }

  async clear() {
    const entries = [...this.locks.values()];
    this.locks.clear();
    for (const lock of entries) {
      if (lock.heartbeat) clearInterval(lock.heartbeat);
      if (lock.filePath && lock.fileToken) {
        const fileLease = await this.#readLease(lock.filePath);
        if (fileLease && fileLease.token === lock.fileToken) await unlink(lock.filePath).catch(() => {});
      }
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
