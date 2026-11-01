import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PORTS, listEndpoints, probeVersion, readRegistry, registryPath, resolveEndpoint } from "../../src/cdp/endpoint.mjs";

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
  const home = await mkdtemp(join(tmpdir(), "bh-endpoint-"));
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
    (error) => {
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
    (error) => {
      assert.equal(error.code, "E_NO_BROWSER");
      assert.equal(error.details.tried.length, 2);
      return true;
    },
  );
});

test("403 becomes an actionable E_NO_BROWSER", async () => {
  await assert.rejects(
    probeVersion("http://127.0.0.1:9331", { fetchImpl: fakeFetch(() => jsonResponse({}, 403)) }),
    (error) => {
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
