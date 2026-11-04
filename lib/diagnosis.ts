/**
 * Automatic failure diagnosis for page tools.
 *
 * The collector is deliberately best-effort: it must never replace or mask the
 * original tool error, never echo input values, and must finish within a small
 * time/size budget.
 */

import { copyFile, mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { redactHeadersForOutput, redactTextForOutput, redactUrlForOutput } from "../src/redact.js";

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 5_000;
const TAIL = 50;

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function errorCode(error: any) {
  if (error && error.code) return String(error.code);
  const match = /^([A-Z][A-Z0-9_]{2,}):/.exec(String(error && error.message ? error.message : ""));
  return match ? match[1] : "E_UNKNOWN";
}

function safeCode(code: any) {
  return String(code || "E_UNKNOWN").replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80) || "E_UNKNOWN";
}

function redactNetwork(event: any) {
  return {
    url: event && event.url !== undefined ? redactUrlForOutput(event.url) : undefined,
    method: event && event.method,
    status: event && event.status,
    type: event && event.type,
    failed: event && event.failed === true,
    failureText: event && event.failureText ? redactTextForOutput(event.failureText) : undefined,
    ...(event && event.headers !== undefined ? { headers: redactHeadersForOutput(event.headers) } : {}),
  };
}

function redactConsole(event: any) {
  return {
    type: event && event.type,
    text: event && event.text !== undefined ? redactTextForOutput(event.text) : undefined,
    ...(event && event.url ? { url: redactUrlForOutput(event.url) } : {}),
  };
}

async function collect(manager: any, sessionId: any, tool: string, error: any) {
  const stateDir = (manager && manager.config && manager.config.stateDir)
    || (manager && manager.connection && manager.connection.config && manager.connection.config.stateDir);
  if (!stateDir) return null;
  const lane = typeof manager.laneFor === "function" ? manager.laneFor(sessionId) : "default";
  const code = safeCode(errorCode(error));
  const directory = join(stateDir, "diagnostics", lane, stamp() + "-" + code);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  let page: any = null;
  try {
    page = await manager.pageFor(sessionId);
  } catch {
    page = null;
  }

  const report: any = {
    version: 1,
    createdAt: new Date().toISOString(),
    tool,
    lane,
    error: {
      code,
      message: error && error.message ? redactTextForOutput(String(error.message)) : "unknown error",
    },
    page: null,
    task: null,
    lock: { held: [], context: false },
    snapshot: null,
    console: [],
    network: [],
    screenshot: null,
  };

  if (manager && manager.locks && typeof manager.locks.snapshot === "function") {
    report.lock.held = manager.locks.snapshot();
  }
  if (manager && manager.contexts && typeof manager.contexts.has === "function") {
    report.lock.context = manager.contexts.has(lane);
  }

  if (page) {
    try {
      const info = await page.info();
      report.page = {
        targetId: page.targetId,
        url: redactUrlForOutput(info && info.url),
        title: info && info.title,
        readyState: info && info.readyState,
        viewport: info && info.viewport,
      };
    } catch {
      report.page = { targetId: page.targetId };
    }
    try {
      const task = await manager.taskStatus(sessionId);
      if (task && task.task) report.task = { id: task.task.id, state: task.task.state, cleanupPolicy: task.task.cleanupPolicy };
    } catch {
      /* task status is optional */
    }
    try {
      report.snapshot = page.lastSnapshot ? { nodes: page.lastSnapshot.length, version: page.snapshotVersion } : null;
    } catch {
      report.snapshot = null;
    }
    try {
      if (typeof page.consoleEvents === "function") report.console = page.consoleEvents().slice(-TAIL).map(redactConsole);
    } catch {
      /* console capture optional */
    }
    try {
      if (typeof page.networkEvents === "function") report.network = page.networkEvents().slice(-TAIL).map(redactNetwork);
    } catch {
      /* network capture optional */
    }
    try {
      const shot = await page.screenshot({ path: "diagnostic-" + stamp() + ".png" });
      if (shot && shot.path) {
        report.screenshot = "screenshot.png";
        await copyFile(shot.path, join(directory, "screenshot.png"));
        await unlink(shot.path).catch(() => {});
      }
    } catch {
      report.screenshot = null;
    }
  }

  let text = JSON.stringify(report, null, 2);
  if (Buffer.byteLength(text) > MAX_BYTES) {
    report.console = [];
    report.network = [];
    text = JSON.stringify(report, null, 2);
  }
  if (Buffer.byteLength(text) > MAX_BYTES) {
    delete report.lock;
    delete report.console;
    delete report.network;
    text = JSON.stringify(report, null, 2);
  }
  const reportPath = join(directory, "report.json");
  await writeFile(reportPath, text, { encoding: "utf8", mode: 0o600 });
  return {
    path: reportPath,
    relativePath: join("diagnostics", lane, directory.split(/[\\/]/).slice(-1)[0], "report.json"),
    code,
    tool,
    screenshot: report.screenshot,
  };
}

export async function collectAutoDiagnosis(manager: any, sessionId: any, tool: string, error: any): Promise<any> {
  let timer: any;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([collect(manager, sessionId, tool, error), timeout]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
