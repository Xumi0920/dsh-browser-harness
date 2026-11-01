/**
 * Launch a throwaway headless Chromium browser for integration tests.
 *
 * Any Chromium-based browser works (Chrome, Chromium, Edge, Brave, Vivaldi,
 * Opera, Arc). Never touches the user's normal browser or profile: a fresh
 * temporary user-data-dir and an ephemeral DevTools port are used every run.
 */

import { spawn, execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Chromium-family executables this helper knows how to launch. */
const BROWSER_PATHS = [
  {
    id: "chrome",
    label: "Google Chrome",
    paths: [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ],
  },
  {
    id: "edge",
    label: "Microsoft Edge",
    paths: [
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "/usr/bin/microsoft-edge",
      "/usr/bin/microsoft-edge-stable",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ],
  },
  {
    id: "chromium",
    label: "Chromium",
    paths: [
      "C:\\Program Files\\Chromium\\Application\\chrome.exe",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ],
  },
  {
    id: "brave",
    label: "Brave",
    paths: [
      "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      "/usr/bin/brave-browser",
      "/usr/bin/brave",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ],
  },
  {
    id: "vivaldi",
    label: "Vivaldi",
    paths: [
      "C:\\Program Files\\Vivaldi\\Application\\vivaldi.exe",
      "/usr/bin/vivaldi",
      "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi",
    ],
  },
  {
    id: "opera",
    label: "Opera",
    paths: [
      "C:\\Program Files\\Opera\\opera.exe",
      "/usr/bin/opera",
      "/Applications/Opera.app/Contents/MacOS/Opera",
    ],
  },
];

/**
 * Every installed Chromium-family browser, in preference order.
 * CHROME_PATH wins when it points at an existing file.
 * @returns {{ id: string, label: string, path: string }[]}
 */
export function findBrowsers() {
  const found = [];
  const override = process.env.CHROME_PATH;
  if (override && existsSync(override)) found.push({ id: "chrome-path", label: "CHROME_PATH", path: override });
  for (const entry of BROWSER_PATHS) {
    const match = entry.paths.find((candidate) => existsSync(candidate));
    if (match) found.push({ id: entry.id, label: entry.label, path: match });
  }
  return found;
}

/** First installed Chromium-family browser (CHROME_PATH first). */
export function findChrome() {
  return findBrowsers()[0]?.path ?? null;
}

/** An installed Chromium browser that is not the default one, for compat tests. */
export function findAlternateChromium() {
  const browsers = findBrowsers();
  if (browsers.length < 2) return null;
  const primary = browsers[0];
  return browsers.slice(1).find((browser) => browser.path !== primary.path) ?? null;
}

/** Kill every Chromium process using this throwaway user-data-dir. */
async function killByUserDataDir(userDataDir) {
  if (process.platform === "win32") {
    const pattern = userDataDir.replace(/'/g, "''");
    const script = "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(chrome|msedge|chromium|brave|vivaldi|opera)" +
      "' -and $_.CommandLine -like '*" + pattern + "*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
    await new Promise((resolve) => execFile("powershell", ["-NoProfile", "-Command", script], () => resolve()));
    return;
  }
  await new Promise((resolve) => execFile("pkill", ["-f", userDataDir], () => resolve()));
}

/** Wait until the freshly launched browser answers /json/version. */
async function waitForCdpReady(httpUrl, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(httpUrl + "/json/version");
      if (response.ok) return;
    } catch {
      /* not ready yet */
    }
    await sleep(100);
  }
  throw new Error("CDP endpoint did not answer at " + httpUrl);
}

/**
 * @param {{ headless?: boolean, extraArgs?: string[], executable?: string, allowExtensions?: boolean }} [options]
 * @returns {Promise<null | { proc: any, port: number, httpUrl: string, userDataDir: string, executable: string, close: () => Promise<void> }>}
 */
export async function launchChrome(options = {}) {
  const executable = options.executable || findChrome();
  if (!executable) return null;
  const userDataDir = await mkdtemp(join(tmpdir(), "bh-browser-"));
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
    ...(options.allowExtensions === true ? [] : ["--disable-extensions"]),
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
  // Edge (and some other Chromium builds) relaunch themselves: the spawned
  // launcher process may exit while the real browser keeps running, so keep
  // polling for DevToolsActivePort even after the process handle exits.
  while (Date.now() < deadline) {
    try {
      text = await readFile(portFile, "utf8");
      if (text.trim().length > 0) break;
    } catch {
      /* not ready yet */
    }
    await sleep(50);
  }
  if (!text.trim()) {
    try { proc.kill(); } catch { /* ignore */ }
    await killByUserDataDir(userDataDir);
    throw new Error("browser did not expose DevToolsActivePort within 20s (" + executable + ")");
  }
  const [portLine] = text.trim().split(/\r?\n/);
  const port = Number(portLine);
  if (!Number.isFinite(port) || port <= 0) throw new Error("invalid DevToolsActivePort: " + text.slice(0, 80));
  await waitForCdpReady("http://127.0.0.1:" + port);
  return {
    proc,
    port,
    executable,
    httpUrl: "http://127.0.0.1:" + port,
    userDataDir,
    async close() {
      try { proc.kill(); } catch { /* ignore */ }
      if (process.platform === "win32" && proc.pid) {
        await new Promise((resolve) => execFile("taskkill", ["/pid", String(proc.pid), "/T", "/F"], () => resolve()));
      }
      // The visible process may be a relaunched child: kill anything still
      // using this throwaway profile so no headless browser leaks.
      await killByUserDataDir(userDataDir);
      await sleep(300);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await rm(userDataDir, { recursive: true, force: true });
          break;
        } catch {
          await sleep(150 * (attempt + 1));
        }
      }
    },
  };
}
