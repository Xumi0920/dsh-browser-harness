/**
 * CDP endpoint discovery for Chromium-based browsers.
 *
 * Any browser that exposes a Chrome DevTools Protocol endpoint works here
 * (Chrome, Chromium, Edge, Brave, Vivaldi, Opera, Arc, ...). Resolution order:
 * explicit ws -> explicit cdpUrl -> environment -> browser selector ->
 * registry default / auto. The module only *probes* running browsers; it never
 * launches, kills, or reconfigures one.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { noBrowser } from "../errors.js";

const DEFAULT_PROBE_TIMEOUT_MS = 2_500;

/**
 * Known Chromium-based browsers and the local ports this harness uses for a
 * dedicated automation instance. The ports are a convenience convention only:
 * any CDP endpoint can be used through `cdpUrl`, `ws`, or a registry entry
 * with `httpUrl`.
 */
export const KNOWN_BROWSERS = Object.freeze({
  chrome: { port: 9331, label: "Google Chrome" },
  edge: { port: 9332, label: "Microsoft Edge" },
  "chrome-beta": { port: 9333, label: "Chrome Beta" },
  chromium: { port: 9334, label: "Chromium" },
  brave: { port: 9335, label: "Brave" },
  vivaldi: { port: 9336, label: "Vivaldi" },
  opera: { port: 9337, label: "Opera" },
  arc: { port: 9338, label: "Arc" },
});

/** Convention ports keyed by browser id (kept for compatibility). */
export const DEFAULT_PORTS = Object.freeze(
  Object.fromEntries(Object.entries(KNOWN_BROWSERS).map(([id, entry]: any) => [id, entry.port])),
);

/** Standard `--remote-debugging-port` values probed as a last-resort fallback. */
export const STANDARD_CDP_PORTS = Object.freeze([9222, 9223]);

export function defaultDshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

export function registryPath(dshHome: any = defaultDshHome()) {
  return join(dshHome, "browser-cdp", "registry.json");
}

/**
 * Read the local browser-cdp registry. Missing/invalid file returns `null`.
 * @param {{ dshHome?: string }} [options]
 */
export async function readRegistry(options: any = {} as any) {
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

function normalizeBaseUrl(value: any) {
  return String(value).replace(/\/$/, "");
}

/** HTTP DevTools base URL for a registry entry or a known browser. */
function candidateFor(id: any, entry: any = {} as any) {
  const known = (KNOWN_BROWSERS as Record<string, any>)[id] || {};
  const httpUrl = typeof entry.httpUrl === "string" && entry.httpUrl.length > 0
    ? normalizeBaseUrl(entry.httpUrl)
    : null;
  const port = Number(entry.port) || known.port || null;
  if (!httpUrl && !port) return null;
  return {
    id,
    label: entry.label || known.label || id,
    httpUrl: httpUrl || "http://127.0.0.1:" + port,
    port,
  };
}

/** Candidates from a registry file; disabled entries are skipped. */
function registryCandidates(registry: any) {
  const out: any[] = [];
  for (const [id, entry] of Object.entries(((registry && registry.browsers) || {}) as Record<string, any>)) {
    if (!entry || entry.enabled === false) continue;
    const candidate = candidateFor(id, entry);
    if (candidate) out.push(candidate);
  }
  return out;
}

/** Candidates when no registry file exists: every known Chromium browser. */
function defaultCandidates() {
  return Object.entries(KNOWN_BROWSERS)
    .map(([id]: any) => candidateFor(id))
    .filter(Boolean);
}

/** Extra endpoints to try when every configured candidate is down. */
function fallbackCandidates(configured: any, disabledIds: any) {
  const tried = new Set(configured.map((candidate: any) => candidate.httpUrl));
  const out: any[] = [];
  for (const [id, entry] of Object.entries(KNOWN_BROWSERS)) {
    if (disabledIds.has(id)) continue;
    const httpUrl = "http://127.0.0.1:" + entry.port;
    if (tried.has(httpUrl)) continue;
    out.push({ id, label: entry.label, httpUrl, port: entry.port });
  }
  for (const port of STANDARD_CDP_PORTS) {
    const httpUrl = "http://127.0.0.1:" + port;
    if (tried.has(httpUrl)) continue;
    out.push({ id: "cdp-" + port, label: "CDP on port " + port, httpUrl, port });
  }
  return out;
}

function disabledBrowserIds(registry: any) {
  const ids = new Set();
  for (const [id, entry] of Object.entries(((registry && registry.browsers) || {}) as Record<string, any>)) {
    if (entry && entry.enabled === false) ids.add(id);
  }
  return ids;
}

/**
 * Probe an HTTP DevTools endpoint.
 * @param {string} httpUrl e.g. http://127.0.0.1:9331
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 * @returns {Promise<{ webSocketDebuggerUrl: string, browser?: string, userAgent?: string }>}
 */
export async function probeVersion(httpUrl: any, options: any = {} as any) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  if (typeof fetchImpl !== "function") throw noBrowser("no fetch implementation available to probe the CDP endpoint");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(normalizeBaseUrl(httpUrl) + "/json/version", { signal: controller.signal });
    if (response.status === 403) {
      throw noBrowser("remote debugging is disabled or needs approval (HTTP 403) for " + httpUrl, { httpUrl, status: 403 });
    }
    if (!response.ok) {
      throw noBrowser("CDP endpoint " + httpUrl + " answered HTTP " + response.status, { httpUrl, status: response.status });
    }
    const body = await response.json();
    if (!body || typeof body.webSocketDebuggerUrl !== "string" || !body.webSocketDebuggerUrl.startsWith("ws://")) {
      throw noBrowser("endpoint " + httpUrl + " is not a usable Chromium DevTools endpoint", { httpUrl });
    }
    return { webSocketDebuggerUrl: body.webSocketDebuggerUrl, browser: body.Browser, userAgent: body["User-Agent"] };
  } catch (error: any) {
    if (error && error.code === "E_NO_BROWSER") throw error;
    const reason = error && error.name === "AbortError" ? "probe timed out" : String(error && error.message ? error.message : error);
    throw noBrowser("cannot reach CDP endpoint " + httpUrl + ": " + reason, { httpUrl });
  } finally {
    clearTimeout(timer);
  }
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
export async function resolveEndpoint(options: any = {} as any) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl;
  const probeOptions = { fetchImpl, timeoutMs: options.probeTimeoutMs };

  const explicitWs = options.ws ?? env.BH_WS;
  if (explicitWs) return { wsUrl: explicitWs, source: "env:BH_WS" };

  const explicitCdp = options.cdpUrl ?? env.BH_CDP_URL;
  if (explicitCdp) {
    const version = await probeVersion(normalizeBaseUrl(explicitCdp), probeOptions);
    return { wsUrl: version.webSocketDebuggerUrl, httpUrl: normalizeBaseUrl(explicitCdp), browser: version.browser, source: "cdp-url" };
  }

  const registry = await readRegistry({ dshHome: options.dshHome });
  const configured = registry && registry.browsers ? registryCandidates(registry) : defaultCandidates();
  const selector = options.browser ?? env.BH_BROWSER;

  if (selector && selector !== "auto") {
    const fromRegistry = registry && registry.browsers ? registry.browsers[selector] : undefined;
    const known = (KNOWN_BROWSERS as Record<string, any>)[selector] || (KNOWN_BROWSERS as Record<string, any>)[String(selector).toLowerCase()];
    const candidate = fromRegistry ? candidateFor(selector, fromRegistry) : known ? candidateFor(selector) : null;
    if (!candidate) {
      const knownIds = new Set([
        ...Object.keys(KNOWN_BROWSERS),
        ...Object.keys((registry && registry.browsers) || {}),
      ]);
      throw noBrowser('unknown browser selector "' + selector + '"', { selector, known: [...knownIds] });
    }
    const version = await probeVersion(candidate.httpUrl, probeOptions);
    return { wsUrl: version.webSocketDebuggerUrl, httpUrl: candidate.httpUrl, browser: version.browser || candidate.id, source: "browser:" + selector };
  }

  const preferred = registry && typeof registry.default === "string" ? registry.default : null;
  const ordered = preferred
    ? [...configured].sort((a: any, b: any) => (a.id === preferred ? -1 : b.id === preferred ? 1 : 0))
    : configured;
  const failures: any[] = [];
  for (const candidate of ordered) {
    try {
      const version = await probeVersion(candidate.httpUrl, probeOptions);
      return { wsUrl: version.webSocketDebuggerUrl, httpUrl: candidate.httpUrl, browser: candidate.id, source: "auto:" + candidate.id };
    } catch (error: any) {
      failures.push(candidate.id + "(" + candidate.httpUrl + "): " + (error && error.message));
    }
  }

  // Nothing configured answered: try the other known Chromium ports and the
  // standard --remote-debugging-port values in parallel.
  const fallbacks = fallbackCandidates(configured, disabledBrowserIds(registry));
  const settled = await Promise.allSettled(fallbacks.map((candidate: any) => probeVersion(candidate.httpUrl, probeOptions)));
  for (let index = 0; index < settled.length; index += 1) {
    const result = settled[index];
    if (result.status === "fulfilled") {
      const candidate = fallbacks[index];
      return { wsUrl: result.value.webSocketDebuggerUrl, httpUrl: candidate.httpUrl, browser: candidate.id, source: "auto-fallback:" + candidate.id };
    }
    failures.push(fallbacks[index].id + "(" + fallbacks[index].httpUrl + "): " + (result.reason && result.reason.message));
  }
  throw noBrowser("no reachable CDP endpoint; start a dedicated Chromium-based browser (Chrome, Edge, Brave, Chromium, Vivaldi, Opera, Arc) with --remote-debugging-port, or pass browser/cdpUrl/ws", { tried: failures });
}

/**
 * Probe every registry (or default) browser for `doctor`/`browser_status`.
 * @param {{ dshHome?: string, fetchImpl?: typeof fetch, probeTimeoutMs?: number }} [options]
 */
export async function listEndpoints(options: any = {} as any) {
  const registry = await readRegistry({ dshHome: options.dshHome });
  const entries = (registry && registry.browsers
    ? Object.entries(registry.browsers)
    : Object.entries(KNOWN_BROWSERS).map(([id, entry]: any) => [id, { label: entry.label, port: entry.port, enabled: true, mode: "cdp" }])) as [string, any][];
  const probeOptions = { fetchImpl: options.fetchImpl, timeoutMs: options.probeTimeoutMs };
  const rows = await Promise.all(entries.map(async ([id, entry]: any) => {
    const candidate = candidateFor(id, entry || {});
    const enabled = !(entry && entry.enabled === false);
    const row: any = {
      id,
      label: (entry && entry.label) || ((KNOWN_BROWSERS as Record<string, any>)[id] && (KNOWN_BROWSERS as Record<string, any>)[id].label) || id,
      port: candidate ? candidate.port : null,
      enabled,
      httpUrl: candidate ? candidate.httpUrl : null,
      status: "disabled",
      browser: null,
    };
    if (!enabled || !candidate) return row;
    try {
      const version = await probeVersion(candidate.httpUrl, probeOptions);
      row.status = "live";
      row.browser = version.browser;
      row.wsUrl = version.webSocketDebuggerUrl;
    } catch (error: any) {
      row.status = "down";
      row.error = error && error.message;
    }
    return row;
  }));
  return rows;
}
