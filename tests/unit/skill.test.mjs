import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SKILL_CONTENT, SKILL_DESCRIPTION, SKILL_NAME, parseSkillFile } from "../../lib/skill.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKILLS_FILE = join(ROOT, "skills", "browser-harness", "SKILL.md");
const ROOT_FILE = join(ROOT, "SKILL.md");

test("skill metadata comes from SKILL.md frontmatter", () => {
  const parsed = parseSkillFile(readFileSync(SKILLS_FILE, "utf8"));
  assert.equal(SKILL_NAME, "browser-harness");
  assert.equal(SKILL_NAME, parsed.meta.name);
  assert.equal(SKILL_DESCRIPTION, parsed.meta.description);
  assert.ok(SKILL_CONTENT.startsWith("# browser-harness"));
});

test("runtime skill body equals the packaged SKILL.md body", () => {
  const parsed = parseSkillFile(readFileSync(SKILLS_FILE, "utf8"));
  assert.equal(SKILL_CONTENT, parsed.body);
});

test("root SKILL.md stays identical to the packaged copy", () => {
  assert.equal(readFileSync(ROOT_FILE, "utf8"), readFileSync(SKILLS_FILE, "utf8"),
    "root SKILL.md and skills/browser-harness/SKILL.md must stay byte-identical");
});

test("parseSkillFile falls back to the whole text without frontmatter", () => {
  const parsed = parseSkillFile("# Title\nbody");
  assert.deepEqual(parsed.meta, {});
  assert.equal(parsed.body, "# Title\nbody");
});
