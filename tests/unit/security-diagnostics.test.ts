import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTools } from "../../dist/lib/tools.js";
import { BrowserManager } from "../../dist/lib/manager.js";
import { probeVersion } from "../../dist/src/cdp/endpoint.js";
import { Page } from "../../dist/src/page.js";
import { FakeTransport } from "./helpers/fake-transport.js";

const SECRET = "F7k2Q9m4Z6p8";

test("browser_status never exposes endpoint credentials", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "bh-sec-status-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(join(fixture, "browser-cdp"));
  await writeFile(join(fixture, "browser-cdp/registry.json"), JSON.stringify({
    browsers: { fixture: { httpUrl: "http://fixture.invalid:9331", enabled: true } },
  }));
  const oldHome = process.env.DSH_HOME;
  const oldFetch = globalThis.fetch;
  process.env.DSH_HOME = fixture;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      webSocketDebuggerUrl: "ws://fixture.invalid:9331/devtools/browser/fixture?access_token=" + SECRET,
      Browser: "SyntheticBrowser",
    }),
  });
  const manager = new BrowserManager({
    browserFactory: async () => ({
      transport: { closed: false },
      version: { product: "SyntheticBrowser" },
      listTabs: async () => [],
      current: async () => null,
      close: async () => {},
    }),
  });
  try {
    const status = createTools({}, manager, {}, (definition) => definition).find((definition) => definition.name === "browser_status");
    const value = await status.execute({}, {});
    const rendered = JSON.stringify(value) + JSON.stringify(status.output.render({}, value));
    assert.equal(rendered.includes(SECRET), false);
    assert.equal(value.endpoints[0].id, "fixture");
    assert.equal("httpUrl" in value.endpoints[0], false);
    assert.equal("wsUrl" in value.endpoints[0], false);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldHome;
    await manager.close();
  }
});

test("connection failures do not copy the configured credential into the tool error", async () => {
  const endpoint = "http://fixture.invalid:9331?access_token=" + SECRET;
  const manager = new BrowserManager({
    browserFactory: async () => probeVersion(endpoint, {
      fetchImpl: async () => { throw new Error("synthetic connection failure"); },
    }),
  });
  let message = "";
  try {
    const navigate = createTools({}, manager, {}, (definition) => definition).find((definition) => definition.name === "browser_navigate");
    await navigate.execute({ url: "https://fixture.invalid/" }, {});
  } catch (error: any) {
    message = error.message;
  } finally {
    await manager.close();
  }
  assert.ok(message.startsWith("E_NO_BROWSER:"));
  assert.equal(message.includes(SECRET), false);
  assert.equal(message.includes("access_token"), false);
});

test("screenshot rejects a junction escape before creating outside directories", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "bh-sec-shot-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const base = join(fixture, "screenshots");
  const outside = join(fixture, "outside");
  await mkdir(base);
  await mkdir(outside);
  await symlink(outside, join(base, "link"), process.platform === "win32" ? "junction" : "dir");
  const transport = new FakeTransport();
  transport.on("Page.captureScreenshot", () => ({ data: Buffer.from("SYNTHETIC_IMAGE").toString("base64") }));
  const page = new Page(
    { transport, config: { screenshotDir: base, stateDir: fixture } },
    { sessionId: "fixture-session", targetId: "fixture-target" },
  );
  const destination = join(outside, "must-not-be-created");
  await assert.rejects(stat(destination), (error: any) => error.code === "ENOENT");
  await assert.rejects(page.screenshot({ path: "link/must-not-be-created/shot.png" }), (error: any) => {
    assert.equal(error.code, "E_POLICY_DENIED");
    return true;
  });
  assert.equal(await stat(destination).then(() => true, () => false), false);
});
