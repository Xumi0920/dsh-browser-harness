/**
 * Pure DSH plugin factory: tool registration, skill registration and teardown.
 *
 * Kept free of the host peer import so it can be unit-tested with injected
 * defineTool / manager implementations (lib/index.ts wires the real ones).
 */

import { BrowserManager } from "./manager.js";
import { createTools } from "./tools.js";
import { SKILL_CONTENT, SKILL_DESCRIPTION, SKILL_NAME } from "./skill.js";

export const name = "browser-harness";
export const inject = ["tools", "skills"];

/** Defaults; the bundle patch can override any key through config. */
export function resolveConfig(config: any = {}) {
  return {
    browser: config.browser,
    cdpUrl: config.cdpUrl,
    ws: config.ws,
    stateDir: config.stateDir,
    downloadDir: config.downloadDir,
    screenshotDir: config.screenshotDir,
    uploadDir: config.uploadDir,
    taskLockTimeoutMs: config.taskLockTimeoutMs,
    strictTabOwnership: config.strictTabOwnership !== false,
    allowBorrowUserTabs: config.allowBorrowUserTabs !== false,
    dialogPolicy: config.dialogPolicy || "auto-dismiss",
    endpointCacheMs: config.endpointCacheMs === undefined ? 1_500 : Number(config.endpointCacheMs),
    maxSnapshotNodes: Number(config.maxSnapshotNodes) || 250,
    tabGroups: config.tabGroups !== false,
    tabGroupTitle: config.tabGroupTitle,
    tabGroupColor: config.tabGroupColor,
    extensionPath: config.extensionPath,
    extensionId: config.extensionId,
  };
}

export interface ApplyDeps {
  defineTool: (definition: any) => any;
  managerFactory?: (settings: any) => any;
}

/** Build the Cordis apply() function with injectable dependencies. */
export function createApply({ defineTool, managerFactory = (settings: any) => new BrowserManager(settings) }: ApplyDeps) {
  return function apply(ctx: any, config: any = {}) {
    const settings = resolveConfig(config);
    const manager = managerFactory(settings);
    const definitions = createTools(ctx, manager, settings, defineTool);
    const disposers = definitions.map((definition: any) => ctx.tools.register(definition));

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

    return { name, tools: definitions.map((definition: any) => definition.name), manager };
  };
}
