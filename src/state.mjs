/**
 * Cross-call state for a daemon-less harness.
 *
 * CDP sessions die with the WebSocket, so we persist only the current
 * `targetId` (plus the tabs we created), never a `sessionId`. Writes are
 * atomic (tmp + rename) and guarded by a short-lived lock file.
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const STATE_VERSION = 1;
export const DEFAULT_MARKER = "🐴";

export function defaultStateDir() {
  return process.env.BH_STATE_DIR || join(process.env.DSH_HOME || join(homedir(), ".dsh"), "browser-harness");
}

export function statePath(lane = "default", dir = defaultStateDir()) {
  const safeLane = String(lane || "default")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[.-]+/, "")
    .slice(0, 64) || "default";
  return join(dir, "state-" + safeLane + ".json");
}

/** @returns {object} a fresh empty state */
export function emptyState() {
  return {
    version: STATE_VERSION,
    endpoint: null,
    current: null,
    ownedTabs: [],
    marker: DEFAULT_MARKER,
    updatedAt: new Date().toISOString(),
  };
}

function normalizeState(value) {
  const base = emptyState();
  if (!value || typeof value !== "object") return base;
  return {
    ...base,
    ...value,
    version: STATE_VERSION,
    ownedTabs: Array.isArray(value.ownedTabs) ? value.ownedTabs.filter((tab) => tab && typeof tab.targetId === "string") : [],
    current: value.current && typeof value.current.targetId === "string" ? value.current : null,
    group: value.group && Number.isFinite(value.group.id) ? value.group : null,
  };
}

/**
 * Read state; a missing or corrupt file yields empty state.
 * @param {string} [lane]
 * @param {string} [dir]
 */
export async function readState(lane = "default", dir = defaultStateDir()) {
  try {
    const raw = await readFile(statePath(lane, dir), "utf8");
    return normalizeState(JSON.parse(raw));
  } catch {
    return emptyState();
  }
}

/**
 * Atomically replace state.
 * @param {object} state
 * @param {string} [lane]
 * @param {string} [dir]
 */
export async function writeState(state, lane = "default", dir = defaultStateDir()) {
  await mkdir(dir, { recursive: true });
  const file = statePath(lane, dir);
  const tmp = file + "." + process.pid + "." + Date.now() + ".tmp";
  const payload = JSON.stringify(normalizeState({ ...state, updatedAt: new Date().toISOString() }), null, 2);
  await writeFile(tmp, payload, "utf8");
  await rename(tmp, file);
  return normalizeState(JSON.parse(payload));
}

const LOCK_STALE_MS = 10_000;
const LOCK_RETRIES = 40;
const LOCK_RETRY_MS = 25;

async function acquireLock(lane, dir) {
  await mkdir(dir, { recursive: true });
  const lock = statePath(lane, dir) + ".lock";
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
    try {
      await writeFile(lock, String(process.pid) + "\n" + Date.now() + "\n", { encoding: "utf8", flag: "wx" });
      return lock;
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      try {
        const raw = await readFile(lock, "utf8");
        const stamp = Number(String(raw).trim().split("\n")[1]);
        if (Number.isFinite(stamp) && Date.now() - stamp > LOCK_STALE_MS) {
          await unlink(lock).catch(() => {});
          continue;
        }
      } catch {
        /* lock disappeared; retry */
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
  throw new Error("state lock timeout for lane " + lane);
}

/**
 * Run `fn` with the lane lock held.
 * @template T
 * @param {string} lane
 * @param {() => Promise<T>} fn
 * @param {string} [dir]
 * @returns {Promise<T>}
 */
export async function withStateLock(lane, fn, dir = defaultStateDir()) {
  const lock = await acquireLock(lane, dir);
  try {
    return await fn();
  } finally {
    await unlink(lock).catch(() => {});
  }
}

/**
 * Locked read-modify-write.
 * @param {string} lane
 * @param {(state: object) => object | Promise<object>} mutate
 * @param {string} [dir]
 */
export async function updateState(lane, mutate, dir = defaultStateDir()) {
  return withStateLock(lane, async () => {
    const state = await readState(lane, dir);
    const next = await mutate(state);
    return writeState(next, lane, dir);
  }, dir);
}

/** Remember a tab this harness created. */
export async function rememberOwnedTab(lane, tab, dir = defaultStateDir()) {
  return updateState(lane, (state) => {
    const owned = state.ownedTabs.filter((item) => item.targetId !== tab.targetId);
    owned.push({ ...tab, createdAt: tab.createdAt || new Date().toISOString() });
    return { ...state, ownedTabs: owned.slice(-50) };
  }, dir);
}

/** Set the current tab pointer. */
export async function setCurrent(lane, current, dir = defaultStateDir()) {
  return updateState(lane, (state) => ({ ...state, current }), dir);
}

/** Remember the Chrome tab group created for a lane (task/session). */
export async function setGroup(lane, group, dir = defaultStateDir()) {
  return updateState(lane, (state) => ({ ...state, group: group ? { ...group, updatedAt: new Date().toISOString() } : null }), dir);
}

/** Forget a closed tab. */
export async function forgetTab(lane, targetId, dir = defaultStateDir()) {
  return updateState(lane, (state) => ({
    ...state,
    current: state.current && state.current.targetId === targetId ? null : state.current,
    ownedTabs: state.ownedTabs.filter((tab) => tab.targetId !== targetId),
  }), dir);
}
