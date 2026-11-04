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
    fileLease: config.fileLease !== false,
    fileLeaseDir: config.fileLeaseDir,
    fileLeaseHeartbeatMs: config.fileLeaseHeartbeatMs,
    fileLeaseStaleMs: config.fileLeaseStaleMs,
    isolation: config.isolation === "context" ? "context" : "shared",
    readOnly: config.readOnly === true,
    autoDiagnose: config.autoDiagnose === "off" ? "off" : "errors",
    cleanupOnDispose: config.cleanupOnDispose !== false,
    cleanupOnSessionDispose: config.cleanupOnSessionDispose !== false,
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

    if (settings.cleanupOnSessionDispose !== false && typeof ctx.on === "function") {
      try {
        const off = ctx.on("session/disposed", (session: any) => {
          const id = session && session.id;
          if (!id || !manager || typeof manager.cleanupSession !== "function") return;
          void manager.cleanupSession(id).catch(() => {});
        });
        if (typeof off === "function") ctx.effect(() => off);
      } catch {
        /* host without per-session lifecycle support */
      }
    }

    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try { dispose(); } catch { /* ignore */ }
      }
      const teardown = settings.cleanupOnDispose !== false && typeof manager.dispose === "function"
        ? manager.dispose()
        : manager.close();
      void teardown.catch(() => {});
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
