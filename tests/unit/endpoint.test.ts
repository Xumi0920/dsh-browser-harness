import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PORTS, listEndpoints, probeVersion, readRegistry, registryPath, resolveEndpoint } from "../../dist/src/cdp/endpoint.js";
import { cleanupTempDirs, tempDir } from "../helpers/temp.js";


after(cleanupTempDirs);

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function fakeFetch(handler) {
  return async (url, init) => handler(String(url), init);
}

async function dshHomeWithRegistry(registry) {
  const home = await tempDir("bh-endpoint-");
  await mkdir(join(home, "browser-cdp"), { recursive: true });
  await writeFile(registryPath(home), JSON.stringify(registry), "utf8");
  return home;
}

const registry = {
  version: 1,
  default: "chrome",
  browsers: {
    chrome: { label: "Chrome", port: 9331, enabled: true },
    edge: { label: "Edge", port: 9332, enabled: false },
    "chrome-beta": { label: "Chrome Beta", port: 9333, enabled: true },
  },
};

test("readRegistry resolves browsers and tolerates missing files", async () => {
  const home = await dshHomeWithRegistry(registry);
  assert.equal((await readRegistry({ dshHome: home })).default, "chrome");
  assert.equal(await readRegistry({ dshHome: join(home, "missing") }), null);
});

test("explicit ws wins without probing", async () => {
  let called = false;
  const endpoint = await resolveEndpoint({
    ws: "ws://127.0.0.1:9999/devtools/browser/x",
    fetchImpl: fakeFetch(() => { called = true; return jsonResponse({}); }),
  });
  assert.equal(endpoint.wsUrl, "ws://127.0.0.1:9999/devtools/browser/x");
  assert.equal(called, false);
  assert.match(endpoint.source, /BH_WS/);
});

test("explicit cdpUrl is probed and normalized", async () => {
  const home = await dshHomeWithRegistry(registry);
  const endpoint = await resolveEndpoint({
    cdpUrl: "http://127.0.0.1:9331/",
    dshHome: home,
    fetchImpl: fakeFetch((url) => {
      assert.equal(url, "http://127.0.0.1:9331/json/version");
      return jsonResponse({ webSocketDebuggerUrl: "ws://127.0.0.1:9331/devtools/browser/abc", Browser: "Chrome/156" });
    }),
  });
  assert.equal(endpoint.wsUrl, "ws://127.0.0.1:9331/devtools/browser/abc");
  assert.equal(endpoint.browser, "Chrome/156");
  assert.equal(endpoint.source, "cdp-url");
});

test("browser selector probes the fixed port and fails closed when down", async () => {
  const home = await dshHomeWithRegistry(registry);
  const live = await resolveEndpoint({
    browser: "chrome-beta",
    dshHome: home,
    fetchImpl: fakeFetch(() => jsonResponse({ webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/beta" })),
  });
  assert.equal(live.wsUrl, "ws://127.0.0.1:9333/devtools/browser/beta");
  assert.equal(live.source, "browser:chrome-beta");

  await assert.rejects(
    resolveEndpoint({
      browser: "chrome-beta",
      dshHome: home,
      fetchImpl: fakeFetch(() => { throw new Error("ECONNREFUSED"); }),
    }),
    (error: any) => {
      assert.equal(error.code, "E_NO_BROWSER");
      return true;
    },
  );
});

test("auto mode prefers the registry default, then falls through enabled browsers", async () => {
  const home = await dshHomeWithRegistry(registry);
  const seen = [];
  const endpoint = await resolveEndpoint({
    dshHome: home,
    fetchImpl: fakeFetch((url) => {
      seen.push(url);
      if (url.includes(":9331")) return jsonResponse({}, 500);
      return jsonResponse({ webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/beta" });
    }),
  });
  assert.equal(endpoint.source, "auto:chrome-beta");
  assert.equal(seen[0], "http://127.0.0.1:9331/json/version");
  assert.equal(seen[1], "http://127.0.0.1:9333/json/version");
});

test("auto mode reports every tried endpoint when nothing is reachable", async () => {
  const home = await dshHomeWithRegistry(registry);
  await assert.rejects(
    resolveEndpoint({ dshHome: home, fetchImpl: fakeFetch(() => { throw new Error("down"); }) }),
    (error: any) => {
      assert.equal(error.code, "E_NO_BROWSER");
      // 2 configured candidates + the other known Chromium ports + 9222/9223
      assert.ok(error.details.tried.length >= 2);
      assert.ok(error.details.tried.some((entry) => entry.startsWith("chrome(")));
      assert.ok(error.details.tried.some((entry) => entry.startsWith("brave(")));
      return true;
    },
  );
});

test("403 becomes an actionable E_NO_BROWSER", async () => {
  await assert.rejects(
    probeVersion("http://127.0.0.1:9331", { fetchImpl: fakeFetch(() => jsonResponse({}, 403)) }),
    (error: any) => {
      assert.equal(error.code, "E_NO_BROWSER");
      assert.match(error.message, /403/);
      return true;
    },
  );
});

test("listEndpoints marks live, down, and disabled browsers", async () => {
  const home = await dshHomeWithRegistry(registry);
  const rows = await listEndpoints({
    dshHome: home,
    fetchImpl: fakeFetch((url) => {
      if (url.includes(":9331")) return jsonResponse({ webSocketDebuggerUrl: "ws://x/1", Browser: "Chrome/156" });
      throw new Error("refused");
    }),
  });
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  assert.equal(byId.chrome.status, "live");
  assert.equal(byId.chrome.browser, "Chrome/156");
  assert.equal(byId["chrome-beta"].status, "down");
  assert.equal(byId.edge.status, "disabled");
  assert.equal(DEFAULT_PORTS.chrome, 9331);
});

const chromiumRegistry = {
  version: 1,
  default: "brave",
  browsers: {
    chrome: { label: "Chrome", port: 9331, enabled: true },
    edge: { label: "Edge", port: 9332, enabled: false },
    "chrome-beta": { label: "Chrome Beta", port: 9333, enabled: false },
    brave: { label: "Brave", httpUrl: "http://127.0.0.1:9555", enabled: true },
  },
};

test("known Chromium browsers share the port convention", () => {
  for (const id of ["chrome", "chrome-beta", "edge", "chromium", "brave", "vivaldi", "opera", "arc"]) {
    assert.equal(typeof DEFAULT_PORTS[id], "number", id + " has a convention port");
  }
  assert.equal(DEFAULT_PORTS.chrome, 9331);
  assert.equal(DEFAULT_PORTS.edge, 9332);
  assert.equal(DEFAULT_PORTS.brave, 9335);
});

test("browser selector accepts any known Chromium browser id", async () => {
  const home = await tempDir("bh-endpoint-");
  const endpoint = await resolveEndpoint({
    browser: "brave",
    dshHome: home,
    fetchImpl: fakeFetch((url) => {
      assert.equal(url, "http://127.0.0.1:9335/json/version");
      return jsonResponse({ webSocketDebuggerUrl: "ws://127.0.0.1:9335/devtools/browser/brave", Browser: "Brave/140" });
    }),
  });
  assert.equal(endpoint.wsUrl, "ws://127.0.0.1:9335/devtools/browser/brave");
  assert.equal(endpoint.source, "browser:brave");
});

test("registry entries can point at any CDP httpUrl (non-standard port/host)", async () => {
  const home = await dshHomeWithRegistry(chromiumRegistry);
  const seen = [];
  const endpoint = await resolveEndpoint({
    dshHome: home,
    fetchImpl: fakeFetch((url) => {
      seen.push(url);
      assert.equal(url, "http://127.0.0.1:9555/json/version");
      return jsonResponse({ webSocketDebuggerUrl: "ws://127.0.0.1:9555/devtools/browser/brave", Browser: "Brave/140" });
    }),
  });
  assert.equal(endpoint.source, "auto:brave");
  assert.deepEqual(seen, ["http://127.0.0.1:9555/json/version"]);
});

test("auto mode falls back to standard Chromium debugging ports", async () => {
  const home = await dshHomeWithRegistry({
    version: 1,
    default: "chrome",
    browsers: { chrome: { port: 9331, enabled: true } },
  });
  const endpoint = await resolveEndpoint({
    dshHome: home,
    fetchImpl: fakeFetch((url) => {
      if (url.includes(":9222")) return jsonResponse({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/any", Browser: "Chromium/140" });
      throw new Error("refused");
    }),
  });
  assert.equal(endpoint.source, "auto-fallback:cdp-9222");
  assert.equal(endpoint.wsUrl, "ws://127.0.0.1:9222/devtools/browser/any");
});

test("unknown browser selectors list every supported browser", async () => {
  const home = await dshHomeWithRegistry(registry);
  await assert.rejects(
    resolveEndpoint({ browser: "safari", dshHome: home, fetchImpl: fakeFetch(() => jsonResponse({})) }),
    (error: any) => {
      assert.equal(error.code, "E_NO_BROWSER");
      for (const id of ["chrome", "edge", "chrome-beta", "chromium", "brave", "vivaldi", "opera", "arc"]) {
        assert.ok(error.details.known.includes(id), id + " is advertised");
      }
      return true;
    },
  );
});

test("listEndpoints without a registry lists every known Chromium browser", async () => {
  const home = await tempDir("bh-endpoint-empty-");
  const rows = await listEndpoints({
    dshHome: home,
    fetchImpl: fakeFetch((url) => {
      if (url.includes(":9331")) return jsonResponse({ webSocketDebuggerUrl: "ws://x/chrome", Browser: "Chrome/156" });
      throw new Error("refused");
    }),
  });
  const ids = rows.map((row) => row.id);
  for (const id of ["chrome", "edge", "chrome-beta", "chromium", "brave", "vivaldi", "opera", "arc"]) {
    assert.ok(ids.includes(id), id + " is listed");
  }
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  assert.equal(byId.chrome.status, "live");
  assert.equal(byId.brave.status, "down");
});

test("resolveEndpoint honors BH_WS and BH_CDP_URL", async () => {
  const ws = await resolveEndpoint({ env: { BH_WS: "ws://127.0.0.1:9999/devtools/browser/x" } });
  assert.equal(ws.source, "env:BH_WS");
  assert.equal(ws.wsUrl, "ws://127.0.0.1:9999/devtools/browser/x");

  const cdp = await resolveEndpoint({
    env: { BH_CDP_URL: "http://127.0.0.1:9333" },
    fetchImpl: fakeFetch(() => jsonResponse({ webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/y", Browser: "Chrome/1" })),
  });
  assert.equal(cdp.source, "cdp-url");
  assert.equal(cdp.wsUrl, "ws://127.0.0.1:9333/devtools/browser/y");
});

test("resolveEndpoint rejects an unknown BH_BROWSER selector", async () => {
  const home = await tempDir("bh-env-");
  await assert.rejects(resolveEndpoint({ env: { BH_BROWSER: "nope" }, dshHome: home }), (error: any) => {
    assert.equal(error.code, "E_NO_BROWSER");
    assert.match(error.message, /unknown browser selector/);
    return true;
  });
});

test("probeVersion maps an aborted probe to E_NO_BROWSER", async () => {
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  });
  await assert.rejects(probeVersion("http://127.0.0.1:1", { fetchImpl, timeoutMs: 20 }), (error: any) => {
    assert.equal(error.code, "E_NO_BROWSER");
    assert.match(error.message, /probe timed out/);
    return true;
  });
});
