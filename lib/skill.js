/**
 * Embedded skill text.
 *
 * The single source of truth is skills/browser-harness/SKILL.md (shipped in the
 * package): its YAML frontmatter supplies the skill name/description and its
 * body is the registered skill content. Keeping one file removes the drift the
 * earlier duplicated string had with the documentation copy.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SKILL_FILE = fileURLToPath(new URL("../skills/browser-harness/SKILL.md", import.meta.url));

/** Minimal frontmatter reader: "key: value" pairs plus a quoted-scalar unwrap. */
export function parseSkillFile(raw) {
  const text = String(raw ?? "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { meta: {}, body: text.trim() };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const entry = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!entry) continue;
    let value = entry[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    meta[entry[1]] = value;
  }
  return { meta, body: match[2].trim() };
}

const FALLBACK_CONTENT = [
  "# browser-harness",
  "",
  "Use the browser_* tools to operate a dedicated, already-running automation Chrome.",
  "Call browser_status first; refs come from browser_snapshot and expire after DOM changes.",
].join("\n");

let parsed;
try {
  parsed = parseSkillFile(readFileSync(SKILL_FILE, "utf8"));
} catch {
  parsed = { meta: {}, body: FALLBACK_CONTENT };
}

export const SKILL_NAME = parsed.meta.name || "browser-harness";
export const SKILL_DESCRIPTION = parsed.meta.description || "Drive the user's dedicated automation Chrome via browser_* tools: navigate, snapshot refs, click/type, extract data, screenshot.";
export const SKILL_CONTENT = parsed.body || FALLBACK_CONTENT;
