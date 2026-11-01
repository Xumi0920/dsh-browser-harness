/**
 * Launch a throwaway headless Chrome for integration tests.
 *
 * Never touches the user's normal browser or profile: a fresh temporary
 * user-data-dir and an ephemeral DevTools port are used every run.
 */

import { spawn, execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * @param {{ headless?: boolean, extraArgs?: string[] }} [options]
 * @returns {Promise<null | { proc: any, port: number, httpUrl: string, userDataDir: string, close: () => Promise<void> }>}
 */
export async function launchChrome(options = {}) {
  const executable = findChrome();
  if (!executable) return null;
  const userDataDir = await mkdtemp(join(tmpdir(), "bh-chrome-"));
  const args = [
    "--remote-debugging-port=0",
    "--user-data-dir=" + userDataDir,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--disable-sync",
    "--disable-extensions",
    "--window-size=1280,800",
    ...(options.headless === false ? [] : ["--headless=new"]),
    ...(process.platform === "linux" ? ["--no-sandbox", "--disable-dev-shm-usage"] : []),
    ...(options.extraArgs || []),
    "about:blank",
  ];
  const proc = spawn(executable, args, { stdio: "ignore", windowsHide: true });
  const portFile = join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + 20_000;
  let text = "";
  while (Date.now() < deadline) {
    try {
      text = await readFile(portFile, "utf8");
      if (text.trim().length > 0) break;
    } catch {
      /* not ready yet */
    }
    if (proc.exitCode !== null) break;
    await sleep(50);
  }
  if (!text.trim()) {
    try { proc.kill(); } catch { /* ignore */ }
    throw new Error("chrome did not expose DevToolsActivePort within 20s (" + executable + ")");
  }
  const [portLine] = text.trim().split(/\r?\n/);
  const port = Number(portLine);
  if (!Number.isFinite(port) || port <= 0) throw new Error("invalid DevToolsActivePort: " + text.slice(0, 80));
  return {
    proc,
    port,
    httpUrl: "http://127.0.0.1:" + port,
    userDataDir,
    async close() {
      try { proc.kill(); } catch { /* ignore */ }
      if (process.platform === "win32" && proc.pid) {
        await new Promise((resolve) => execFile("taskkill", ["/pid", String(proc.pid), "/T", "/F"], () => resolve()));
      }
      await sleep(300);
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
