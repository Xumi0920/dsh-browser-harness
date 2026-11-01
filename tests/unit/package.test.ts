import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const semver = require("semver");
const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

// Mirrors the DSH plugin-manager compatibility check:
// semver.satisfies(runtimeVersion, range, { includePrerelease: true })
function accepts(runtimeVersion, range) {
  return semver.satisfies(runtimeVersion, range, { includePrerelease: true });
}

test("engines.dsh accepts the current runtime and all newer versions", () => {
  assert.equal(typeof pkg.engines.dsh, "string");
  assert.ok(accepts("0.2.1-rc.5", pkg.engines.dsh), "current DSH version is supported");
  assert.ok(accepts("0.2.1", pkg.engines.dsh));
  assert.ok(accepts("0.3.0", pkg.engines.dsh), "no upper bound");
  assert.ok(accepts("1.0.0", pkg.engines.dsh), "no upper bound");
  assert.equal(accepts("0.2.0", pkg.engines.dsh), false, "older releases are refused");
});

test("DSH peer requirements accept the current and future runtimes", () => {
  const peers = Object.entries(pkg.peerDependencies || {}).filter(([name]) => name.startsWith("@deepseek-ai/dsh"));
  assert.ok(peers.length > 0, "at least one DSH peer is declared");
  for (const [name, range] of peers) {
    assert.ok(accepts("0.2.1-rc.5", range), name + " accepts the current DSH");
    assert.ok(accepts("0.5.0", range), name + " has no upper bound");
  }
});
