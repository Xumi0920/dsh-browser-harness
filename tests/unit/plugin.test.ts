import test from "node:test";
import assert from "node:assert/strict";
import { createApply, resolveConfig } from "../../dist/lib/plugin.js";

function fakeCtx() {
  const registered = [];
  const effects = [];
  const handlers = new Map();
  let skill = null;
  return {
    registered,
    effects,
    handlers,
    get skill() { return skill; },
    tools: { register(definition) { registered.push(definition); return () => {}; } },
    effect(effect) { effects.push(effect); return () => {}; },
    on(event, handler) { handlers.set(event, handler); return () => handlers.delete(event); },
    get(name) { return name === "skills" ? { register(spec) { skill = spec; return () => {}; } } : undefined; },
  };
}

test("createApply registers all thirteen tools, the skill and teardown", async () => {
  const ctx = fakeCtx();
  let closed = false;
  const apply = createApply({
    defineTool: (definition) => ({ ...definition, defined: true }),
    managerFactory: () => ({ close: async () => { closed = true; } }),
  });
  const result = apply(ctx, { tabGroups: false, tabGroupTitle: "任务 {session}" });
  assert.equal(ctx.registered.length, 13);
  assert.deepEqual(
    ctx.registered.map((definition) => definition.name).sort(),
    ["browser_act", "browser_diagnose", "browser_download", "browser_extract", "browser_navigate", "browser_pdf", "browser_screenshot", "browser_snapshot", "browser_status", "browser_tabs", "browser_task", "browser_upload", "browser_wait"],
  );
  assert.ok(ctx.registered.every((definition) => definition.defined === true));
  assert.equal(ctx.skill.name, "browser-harness");
  assert.equal(result.name, "browser-harness");
  assert.equal(result.tools.length, 13);
  for (const effect of ctx.effects) {
    const cleanup = effect();
    if (typeof cleanup === "function") cleanup();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(closed, true, "manager is closed on teardown");
});

test("resolveConfig defaults tab groups on and keeps explicit overrides", () => {
  assert.equal(resolveConfig({}).tabGroups, true);
  assert.equal(resolveConfig({ tabGroups: false }).tabGroups, false);
  assert.equal(resolveConfig({ tabGroupTitle: "任务 {session}" }).tabGroupTitle, "任务 {session}");
  assert.equal(resolveConfig({ maxSnapshotNodes: 42 }).maxSnapshotNodes, 42);
});

test("createApply cleans browser resources when a session is disposed", async () => {
  const ctx = fakeCtx();
  const cleaned = [];
  const apply = createApply({
    defineTool: (definition) => definition,
    managerFactory: () => ({ close: async () => {}, cleanupSession: async (id) => { cleaned.push(id); return { cleaned: 1 }; } }),
  });
  apply(ctx, { tabGroups: false });
  assert.equal(typeof ctx.handlers.get("session/disposed"), "function");
  ctx.handlers.get("session/disposed")({ id: "session-1" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(cleaned, ["session-1"]);
});
