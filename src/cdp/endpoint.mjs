/**
 * CDP endpoint discovery.
 *
 * Resolution order: explicit ws -> explicit cdpUrl -> environment -> browser
 * selector -> registry default / auto. The module only *probes* running
 * browsers; it never launches, kills, or reconfigures one.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { noBrowser } from "../errors.mjs";

const DEFAULT_PROBE_TIMEOUT_MS = 2_500;

/** Ports used by the local dedicated automation instances (read-only convention). */
export const DEFAULT_PORTS = Object.freeze({ chrome: 9331, edge: 9332, "chrome-beta": 9333 });

export function defaultDshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

export function registryPath(dshHome = defaultDshHome()) {
  return join(dshHome, "browser-cdp", "registry.json");
}

/**
 * Read the local browser-cdp registry. Missing/invalid file returns `null`.
 * @param {{ dshHome?: string }} [options]
 */
export async function readRegistry(options = {}) {
  const file = registryPath(options.dshHome);
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || typeof parsed.browsers !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Probe an HTTP DevTools endpoint.
 * @param {string} httpUrl e.g. http://127.0.0.1:9331
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 * @returns {Promise<{ webSocketDebuggerUrl: string, browser?: string, userAgent?: string }>}
 */
export async function probeVersion(httpUrl, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  if (typeof fetchImpl !== "function") throw noBrowser("no fetch implementation available to probe the CDP endpoint");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(httpUrl.replace(/\/$/, "") + "/json/version", { signal: controller.signal });
    if (response.status === 403) {
      throw noBrowser("remote debugging is disabled or needs approval (HTTP 403) for " + httpUrl, { httpUrl, status: 403 });
    }
    if (!response.ok) {
      throw noBrowser("CDP endpoint " + httpUrl + " answered HTTP " + response.status, { httpUrl, status: response.status });
    }
    const body = await response.json();
    if (!body || typeof body.webSocketDebuggerUrl !== "string" || !body.webSocketDebuggerUrl.startsWith("ws://")) {
      throw noBrowser("endpoint " + httpUrl + " is not a usable Chrome DevTools endpoint", { httpUrl });
    }
    return { webSocketDebuggerUrl: body.webSocketDebuggerUrl, browser: body.Browser, userAgent: body["User-Agent"] };
  } catch (error) {
    if (error && error.code === "E_NO_BROWSER") throw error;
    const reason = error && error.name === "AbortError" ? "probe timed out" : String(error && error.message ? error.message : error);
    throw noBrowser("cannot reach CDP endpoint " + httpUrl + ": " + reason, { httpUrl });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeBaseUrl(value) {
  return String(value).replace(/\/$/, "");
}

/**
 * Resolve a browser endpoint to a live WebSocket URL.
 * @param {{
 *   ws?: string,
 *   cdpUrl?: string,
 *   browser?: string,
 *   dshHome?: string,
 *   fetchImpl?: typeof fetch,
 *   probeTimeoutMs?: number,
 *   env?: Record<string, string|undefined>,
 * }} [options]
 * @returns {Promise<{ wsUrl: string, httpUrl?: string, browser?: string, source: string }>}
 */
export async function resolveEndpoint(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl;
  const probeTimeoutMs = options.probeTimeoutMs;

  const explicitWs = options.ws ?? env.BH_WS;
  if (explicitWs) return { wsUrl: explicitWs, source: "env:BH_WS" };

  const explicitCdp = options.cdpUrl ?? env.BH_CDP_URL;
  if (explicitCdp) {
    const version = await probeVersion(normalizeBaseUrl(explicitCdp), { fetchImpl, timeoutMs: probeTimeoutMs });
    return { wsUrl: version.webSocketDebuggerUrl, httpUrl: normalizeBaseUrl(explicitCdp), browser: version.browser, source: "cdp-url" };
  }

  const registry = await readRegistry({ dshHome: options.dshHome });
  /** @type {Array<{ id: string, port: number, label?: string }>} */
  const candidates = [];
  if (registry && registry.browsers) {
    for (const [id, entry] of Object.entries(registry.browsers)) {
      if (!entry || entry.enabled === false) continue;
      const port = Number(entry.port) || DEFAULT_PORTS[id];
      if (port) candidates.push({ id, port, label: entry.label || id });
    }
  } else {
    for (const [id, port] of Object.entries(DEFAULT_PORTS)) candidates.push({ id, port, label: id });
  }

  const selector = options.browser ?? env.BH_BROWSER;
  if (selector && selector !== "auto") {
    const wanted = candidates.find((candidate) => candidate.id === selector);
    const port = wanted ? wanted.port : DEFAULT_PORTS[selector];
    if (!port) throw noBrowser(`unknown browser selector "${selector}"`, { selector, known: Object.keys(DEFAULT_PORTS) });
    const httpUrl = "http://127.0.0.1:" + port;
    const version = await probeVersion(httpUrl, { fetchImpl, timeoutMs: probeTimeoutMs });
    return { wsUrl: version.webSocketDebuggerUrl, httpUrl, browser: wanted ? wanted.id : selector, source: "browser:" + selector };
  }

  const preferred = registry && typeof registry.default === "string" ? registry.default : null;
  const ordered = preferred ? [...candidates].sort((a, b) => (a.id === preferred ? -1 : b.id === preferred ? 1 : 0)) : candidates;
  const failures = [];
  for (const candidate of ordered) {
    const httpUrl = "http://127.0.0.1:" + candidate.port;
    try {
      const version = await probeVersion(httpUrl, { fetchImpl, timeoutMs: probeTimeoutMs });
      return { wsUrl: version.webSocketDebuggerUrl, httpUrl, browser: candidate.id, source: "auto:" + candidate.id };
    } catch (error) {
      failures.push(candidate.id + "(" + candidate.port + "): " + (error && error.message));
    }
  }
  throw noBrowser("no reachable CDP endpoint; start a dedicated automation browser or pass --cdp-url/--ws", { tried: failures });
}

/**
 * Probe every registry browser for `doctor`.
 * @param {{ dshHome?: string, fetchImpl?: typeof fetch, probeTimeoutMs?: number }} [options]
 */
export async function listEndpoints(options = {}) {
  const registry = await readRegistry({ dshHome: options.dshHome });
  const browserEntries = registry && registry.browsers ? registry.browsers : Object.fromEntries(
    Object.entries(DEFAULT_PORTS).map(([id, port]) => [id, { label: id, port, enabled: id !== "edge", mode: "cdp" }]),
  );
  const rows = [];
  for (const [id, entry] of Object.entries(browserEntries)) {
    const port = Number(entry && entry.port) || DEFAULT_PORTS[id];
    const httpUrl = port ? "http://127.0.0.1:" + port : null;
    const row = { id, label: entry && entry.label || id, port, enabled: !(entry && entry.enabled === false), httpUrl, status: "disabled", browser: null };
    if (row.enabled && httpUrl) {
      try {
        const version = await probeVersion(httpUrl, { fetchImpl: options.fetchImpl, timeoutMs: options.probeTimeoutMs });
        row.status = "live";
        row.browser = version.browser;
        row.wsUrl = version.webSocketDebuggerUrl;
      } catch (error) {
        row.status = "down";
        row.error = error && error.message;
      }
    }
    rows.push(row);
  }
  return rows;
}
