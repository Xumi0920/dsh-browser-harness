/**
 * DSH plugin entry: registers the browser_* tools and embeds the skill.
 *
 * Loaded by the Cordis loader from the bundle patch (cordis.patch.yml).
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import { BrowserManager } from "./manager.js";
import { createTools } from "./tools.js";
import { SKILL_CONTENT, SKILL_DESCRIPTION, SKILL_NAME } from "./skill.js";

export const name = "browser-harness";
export const inject = ["tools"];

/** Defaults; the bundle patch can override any key through `config`. */
function resolveConfig(config = {}) {
  return {
    browser: config.browser,
    cdpUrl: config.cdpUrl,
    ws: config.ws,
    stateDir: config.stateDir,
    downloadDir: config.downloadDir,
    dialogPolicy: config.dialogPolicy || "auto-dismiss",
    maxSnapshotNodes: Number(config.maxSnapshotNodes) || 250,
    tabGroups: config.tabGroups !== false,
    tabGroupTitle: config.tabGroupTitle,
    tabGroupColor: config.tabGroupColor,
    extensionPath: config.extensionPath,
    extensionId: config.extensionId,
  };
}

export function apply(ctx, config = {}) {
  const settings = resolveConfig(config);
  const manager = new BrowserManager(settings);
  const definitions = createTools(ctx, manager, settings, defineTool);
  const disposers = definitions.map((definition) => ctx.tools.register(definition));

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try { dispose(); } catch { /* ignore */ }
    }
    void manager.close();
  });

  // Best effort: also expose the workflow as a runtime skill.
  try {
    const skills = ctx.get && ctx.get("skills");
    if (skills && typeof skills.register === "function") {
      const registration = skills.register({ name: SKILL_NAME, description: SKILL_DESCRIPTION, content: SKILL_CONTENT, source: "bundled" });
      if (typeof registration === "function") ctx.effect(() => registration);
    }
  } catch {
    /* skill service is optional */
  }

  return { name, tools: definitions.map((definition) => definition.name), manager };
}

export default { name, inject, apply };
