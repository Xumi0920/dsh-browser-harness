# dsh-browser-harness

[简体中文](README.md) | **English**

**Native browser tools for DeepSeek Harness (DSH).** A zero-dependency CDP core exposes `browser_*` tools that drive a *dedicated, already-running* Chromium-based browser (Chrome, Chromium, Edge, Brave, Vivaldi, Opera, Arc, ...) — a real browser with real login state — plus a compact accessibility snapshot with clickable refs.

```
browser_status      endpoint, browser version, tabs, current tab
browser_navigate    open a URL, return info + snapshot
browser_snapshot    compact refs (e1 ...) with role/name/viewport center
browser_act         click / type / fill / press / scroll
browser_extract     text / html / JS / network
browser_screenshot  PNG path
browser_tabs        list / use / new / close
```

## Why not just Playwright?

- **Zero dependencies.** Node 22+ built-ins only (`fetch`, `WebSocket`, `node:test`). No browser download, no build step. The DSH plugin entry imports the host-provided `@deepseek-ai/dsh-tools` peer — nothing else.
- **Your logged-in browser.** Point it at a dedicated Chromium-based instance (default `chrome` = 9331; Edge/Brave/Chromium/... also supported — see *Supported browsers*) that the user signed in once.
- **Text-first.** Accessibility-tree snapshots and refs beat screenshot-VLM loops for actions; screenshots stay optional.
- **Scene-tested.** 80 unit tests + 25 end-to-end scenarios (14 browser scenarios + 11 tool-layer/CLI/compat scenarios, 105 total: login, async render, tabs, iframe, shadow DOM, download, upload, dialogs, validation, timeout, stale-tab recovery, screenshots, network capture, cookies) run against a real headless Chromium and a local fixture site.

## Requirements

- DSH `0.2.1-rc.5` (`engines.dsh`)
- Node.js >= 22
- A dedicated Chromium-based browser with remote debugging enabled
- Platform: verified on Windows first; macOS / Linux untested
- Default registry ports: see *Supported browsers*; the registry file is `~/.dsh/browser-cdp/registry.json`

## Supported browsers

Any **Chromium-based browser that exposes a CDP remote-debugging endpoint** works: Chrome, Chromium, Edge, Brave, Vivaldi, Opera, Arc, ...

| Browser | Default port (this project's convention) | `browser` selector |
|---|---|---|
| Google Chrome | 9331 | `chrome` |
| Microsoft Edge | 9332 | `edge` |
| Chrome Beta | 9333 | `chrome-beta` |
| Chromium | 9334 | `chromium` |
| Brave | 9335 | `brave` |
| Vivaldi | 9336 | `vivaldi` |
| Opera | 9337 | `opera` |
| Arc | 9338 | `arc` |
| Other CDP ports | 9222 / 9223 (auto-probed when no `browser` is given) | — |

The ports are only a local convention: `browser: "brave"` probes 9335, and `cdpUrl` / `ws` can point at any CDP endpoint (remote included). Registry entries also accept `httpUrl`. `browser: "auto"` (the default) tries the configured instances first and then falls back to the other known Chromium ports and 9222/9223.

## Install (DSH 0.2.1-rc.5)

This plugin is **not published to npm** — the same-named npm package belongs to an unrelated project, so install it from a local clone directory or directly from the GitHub repository.

The example path `C:\path\to\dsh-browser-harness` is a placeholder; replace it with the absolute path of your local clone (an earlier doc revision used the author's own absolute path there; that is obsolete).

```powershell
# 1) Clone the repository to any directory on your machine (replace the placeholder path):
git clone https://github.com/Xumi0920/dsh-browser-harness.git C:\path\to\dsh-browser-harness

# 2) Install the local directory in Creator mode / plugin manager:
#    target is a JSON string, so each backslash must be written twice (JSON escaping);
#    the real path is C:\path\to\dsh-browser-harness — use your own clone path.
#    plugin_manager { action: "install_bundle", target: "C:\\path\\to\\dsh-browser-harness" }

# 3) Or use the CLI (restart DSH afterwards):
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
  plugin --profile desktop add "C:\path\to\dsh-browser-harness"
```

> Each `plugin_manager` operation needs a danger-full-access sandbox or per-call approval. Its `target` accepts an npm package name, a git URL, a tarball, or a local absolute directory.

The plugin is a DSH bundle (`dsh.bundle.patch` -> `cordis.patch.yml`), so it registers `browser_*` tools at profile level and embeds the `browser-harness` skill. See [install.md](install.md) (currently Chinese) for the full install, verify and uninstall steps.

## Configure the target browser

Defaults read `~/.dsh/browser-cdp/registry.json` and attach to the default dedicated instance (`chrome` on port 9331). To change settings, apply an **id-targeted override** in the profile patch (`~/.dsh/profiles/desktop/cordis.patch.yml`); `browser` accepts any supported selector such as `edge`, `brave` or `chromium`:

```yaml
- id: browser-harness
  name: dsh-browser-harness
  config:
    browser: chrome-beta      # or chrome
    # cdpUrl: http://127.0.0.1:9333
    # ws: ws://127.0.0.1:9333/devtools/browser/<id>
    maxSnapshotNodes: 250
    # stateDir: ~/.dsh/browser-harness
    # downloadDir: ~/.dsh/browser-harness/downloads
    # dialogPolicy: auto-dismiss
```

> **Do not** add another `- insert:` row in the profile patch — that would register the plugin twice; `insert` is how the plugin package's own `cordis.patch.yml` registers it. Config keys: `browser` picks the target instance; `cdpUrl` / `ws` point directly at an endpoint (pick one); `maxSnapshotNodes` defaults to 250 (`browser_snapshot` caps at 400); `stateDir` / `downloadDir` control runtime state and downloads; `dialogPolicy` defaults to `auto-dismiss`.

The harness only *probes* running browsers; it never launches, kills, or reconfigures one. Start a dedicated instance yourself with any Chromium-based browser you have:

```powershell
# Google Chrome / Chromium = 9331
chrome.exe --remote-debugging-port=9331 "--user-data-dir=$env:USERPROFILE\.dsh\browser-cdp\profiles\chrome"
# Microsoft Edge = 9332
msedge.exe --remote-debugging-port=9332 "--user-data-dir=$env:USERPROFILE\.dsh\browser-cdp\profiles\edge"
# Brave = 9335
brave.exe  --remote-debugging-port=9335 "--user-data-dir=$env:USERPROFILE\.dsh\browser-cdp\profiles\brave"
```

Any port works too (e.g. 9222): `browser: "auto"` falls back to it, or point `cdpUrl` at `http://127.0.0.1:9222`. Registry entries may use `httpUrl` instead of `port`, e.g. `"brave": { "label": "Brave", "httpUrl": "http://127.0.0.1:9222", "enabled": true }`.

## Standalone library / CLI

```js
import { connect } from "./src/index.mjs";
const bh = await connect({ browser: "chrome" });
const page = await bh.newTab("https://example.com");
console.log(await page.info(), (await page.snapshot()).nodes.length);
await page.click({ selector: "a" });
await page.screenshot({ path: "shot.png" });
await bh.close();
```

```sh
node bin/bh.mjs doctor
node bin/bh.mjs open https://example.com
node bin/bh.mjs snapshot
node bin/bh.mjs close
```

CLI subcommands: `doctor`, `tabs`, `open <url>`, `info`, `snapshot`, `text [selector]`, `js <expr>`, `shot [path]`, `close` (close the CLI's current tab; by default only harness-created tabs, `--force` to force). `node scripts/verify.mjs [--browser chrome|edge|brave|...]` smoke-tests a live dedicated browser.

## Test

Run from a source checkout. The packed artifact (`npm pack`) contains the runtime only — no `tests/`, `scripts/`, or `fixtures/`; this plugin is not published to npm, so install it from source or a local directory.

```sh
npm test                    # unit: CDP protocol, endpoint, state, AX, tools (no browser)
npm run test:integration    # 25 scenarios on a throwaway headless Chromium
npm run test:all            # unit + integration (105 tests)
node scripts/verify.mjs     # smoke against a live dedicated browser
```

Integration tests launch their own Chromium browser with a temporary profile and never touch the user's browser; they skip when none is available.

## Safety

- Only tabs this harness creates are closed; by default `browser_tabs` never closes user tabs (`force` requires explicit user consent).
- The cookies API redacts values by default; the harness does not read or print cookies/tokens on its own. Note that `browser_status` / `browser_tabs` return tab URLs verbatim (a URL may embed sensitive parameters such as a token) — do not leak that output.
- `browser_extract` modes `network` and `js` return exactly what the page exposes when explicitly asked (`network` returns the tab's most recent request events since the connection, up to 100; `includeBody` is slower; response headers may contain `Set-Cookie`); `browser_tabs {action:"use"}` can attach the session to an existing tab, after which `browser_act` operates on it. Use these intentionally, and never point `cdpUrl` at a daily-driver browser.
- Background operations only — no `Page.bringToFront` unless explicitly requested.
- Login walls stop the workflow and ask the user.

## Status

v0.2.0 — current release. Supported browsers now span **any Chromium-based browser** (Chrome, Chromium, Edge, Brave, Vivaldi, Opera, Arc, ...), with port conventions and `browser` selectors, 9222/9223 auto-probing, and registry `httpUrl` support; it also carries the earlier network-capture fix, strict snapshot-ref validation, reused/released Page CDP sessions, real `owned` flags, the truthful truncation flag and `bh close`. Pinned to DSH `0.2.1-rc.5` through `engines.dsh`. Downloads/uploads/cookies exist in the core library but are intentionally not exposed as tools yet. See the [Releases page](https://github.com/Xumi0920/dsh-browser-harness/releases) for the changelog.

MIT (c) 2026 Xumi0920
