# dsh-browser-harness

**Native browser tools for DeepSeek Harness (DSH).** A zero-dependency CDP core exposes `browser_*` tools that drive a *dedicated, already-running* Chrome — a real browser with real login state — plus a compact accessibility snapshot with clickable refs.

```
browser_status      endpoint, Chrome version, tabs, current tab
browser_navigate    open a URL, return info + snapshot
browser_snapshot    compact refs (e1 ...) with role/name/viewport center
browser_act         click / type / fill / press / scroll
browser_extract     text / html / JS / network
browser_screenshot  PNG path
browser_tabs        list / use / new / close
```

## Why not just Playwright?

- **Zero dependencies.** Node 22+ built-ins only (`fetch`, `WebSocket`, `node:test`). No browser download, no build step. The DSH plugin entry imports the host-provided `@deepseek-ai/dsh-tools` peer — nothing else.
- **Your logged-in Chrome.** Point it at a dedicated instance (e.g. `--remote-debugging-port=9331 --user-data-dir=...`) that the user signed in once.
- **Text-first.** Accessibility-tree snapshots and refs beat screenshot-VLM loops for actions; screenshots stay optional.
- **Scene-tested.** 37 unit tests + 14 end-to-end scenarios (51 total: login, async render, tabs, iframe, shadow DOM, download, upload, dialogs, validation, timeout, stale-tab recovery, screenshots, network capture, cookies) run against a real headless Chrome and a local fixture site.

## Install (DSH 0.2.1-rc.5)

```powershell
# From a local checkout (Creator mode / plugin manager):
#   plugin_manager { action: "install_bundle", target: "G:\\path\\to\\dsh-browser-harness" }
# Or CLI (restart DSH afterwards):
& "$env:LOCALAPPDATA\\Programs\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd" `
  plugin --profile desktop add "G:\\path\\to\\dsh-browser-harness"
```

The plugin is a DSH bundle (`dsh.bundle.patch` -> `cordis.patch.yml`), so it registers `browser_*` tools at profile level and embeds the `browser-harness` skill.

## Configure the target browser

Defaults read `~/.dsh/browser-cdp/registry.json` and attach to the default dedicated instance (`chrome` on port 9331). Override in the patch row:

```yaml
- insert:
    - id: browser-harness
      name: dsh-browser-harness
      config:
        browser: chrome-beta      # or chrome
        # cdpUrl: http://127.0.0.1:9333
        # ws: ws://127.0.0.1:9333/devtools/browser/<id>
        maxSnapshotNodes: 250
```

The harness only *probes* running browsers; it never launches, kills, or reconfigures one. Start a dedicated instance yourself:

```powershell
chrome.exe --remote-debugging-port=9331 "--user-data-dir=$env:USERPROFILE\.dsh\browser-cdp\profiles\chrome"
```

## Standalone library / CLI

```js
import { connect } from "./src/index.mjs";
const bh = await connect({ browser: "chrome" });
const page = await bh.newTab("https://example.com");
console.log(await page.info(), (await page.snapshot()).nodes.length);
await page.click({ selector: "a" });
await page.screenshot({ path: "shot.png" });
bh.close();
```

```sh
node bin/bh.mjs doctor
node bin/bh.mjs open https://example.com
node bin/bh.mjs snapshot
```

## Test

Run from a source checkout (npm-packed installs ship the runtime only):

```sh
npm test                    # unit: CDP protocol, endpoint, state, AX, tools (no browser)
npm run test:integration    # 14 scenarios on a throwaway headless Chrome
npm run test:all            # unit + integration (51 tests)
node scripts/verify.mjs     # smoke against a live dedicated Chrome
```

Integration tests launch their own Chrome with a temporary profile and never touch the user's browser; if no Chrome is found they skip.

## Safety

- Only tabs this harness creates are closed; `browser_tabs` never closes user tabs.
- The cookies API redacts values by default; the harness does not log secrets.
- `browser_extract` modes `network` and `js` return exactly what the page exposes when explicitly asked (response headers may contain `Set-Cookie`); `browser_tabs {action:"use"}` can attach the session to an existing tab, after which `browser_act` operates on it. Use these intentionally, and never point `cdpUrl` at a daily-driver Chrome.
- Background operations only — no `Page.bringToFront` unless explicitly requested.
- Login walls stop the workflow and ask the user.

## Status

v0.1.0 — first native-plugin release, pinned to DSH `0.2.1-rc.5` through `engines.dsh`. Downloads/uploads/cookies exist in the core library but are intentionally not exposed as tools yet.

MIT (c) 2026 Xumi0920
