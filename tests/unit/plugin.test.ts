import test from "node:test";
import assert from "node:assert/strict";
import { createApply, resolveConfig } from "../../dist/lib/plugin.js";

function fakeCtx() {
  const registered = [];
  const effects = [];
  let skill = null;
  return {
    registered,
    effects,
    get skill() { return skill; },
    tools: { register(definition) { registered.push(definition); return () => {}; } },
    effect(effect) { effects.push(effect); return () => {}; },
    get(name) { return name === "skills" ? { register(spec) { skill = spec; return () => {}; } } : undefined; },
  };
}

test("createApply registers all eleven tools, the skill and teardown", async () => {
  const ctx = fakeCtx();
  let closed = false;
  const apply = createApply({
    defineTool: (definition) => ({ ...definition, defined: true }),
    managerFactory: () => ({ close: async () => { closed = true; } }),
  });
  const result = apply(ctx, { tabGroups: false, tabGroupTitle: "任务 {session}" });
  assert.equal(ctx.registered.length, 11);
  assert.deepEqual(
    ctx.registered.map((definition) => definition.name).sort(),
    ["browser_act", "browser_download", "browser_extract", "browser_navigate", "browser_pdf", "browser_screenshot", "browser_snapshot", "browser_status", "browser_tabs", "browser_upload", "browser_wait"],
  );
  assert.ok(ctx.registered.every((definition) => definition.defined === true));
  assert.equal(ctx.skill.name, "browser-harness");
  assert.equal(result.name, "browser-harness");
  assert.equal(result.tools.length, 11);
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