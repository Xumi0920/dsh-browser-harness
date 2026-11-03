# dsh-browser-harness

[简体中文](README.md) | **English**

[![ci](https://github.com/Xumi0920/dsh-browser-harness/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Xumi0920/dsh-browser-harness/actions/workflows/ci.yml)
[![codeql](https://github.com/Xumi0920/dsh-browser-harness/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/Xumi0920/dsh-browser-harness/actions/workflows/codeql.yml)
[![version](https://img.shields.io/github/package-json/v/Xumi0920/dsh-browser-harness?label=version)](https://github.com/Xumi0920/dsh-browser-harness/releases)
[![license](https://img.shields.io/github/license/Xumi0920/dsh-browser-harness?label=license)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-339933)](package.json)
[![typescript](https://img.shields.io/badge/typescript-7.0.2-3178C6)](https://www.typescriptlang.org/)
[![chromium](https://img.shields.io/badge/chromium-any-4285F4)](docs/configuration.md)

**Native browser tools for DeepSeek Harness (DSH).** A zero-dependency CDP core exposes thirteen `browser_*` tools that drive a *dedicated, already-logged-in* Chromium-based browser, return compact e1/e2 ref snapshots, and group harness-created tabs per task.

## Tools

```
browser_status      endpoint / browser version / tabs / current tab
browser_wait        appear/disappear, URL/text change, response, network_idle, delay
browser_navigate    open a URL, or back / forward / reload
browser_snapshot    compact refs (e1 ...); frameId, pagination, checked/selected/expanded
browser_act         click / hover / highlight / type / fill / selectOption / check / uncheck / press / scroll / dialog
browser_extract     text / html / JS / network / console / frames
browser_screenshot  full-page or element PNG path
browser_pdf         page PDF path
browser_diagnose    screenshot + console + network failures + active requests
browser_upload      set a file input; paths confined to uploadDir
browser_download    trigger and await a download; files land in downloadDir
browser_task        status / pause / resume / close for task lifecycle
browser_tabs        list / use / new / close
```

## Highlights

- **Zero runtime dependencies + all TypeScript.** The build uses only Node built-ins (`fetch` / `WebSocket`) and never downloads a browser. Sources, tests, scripts and the extension are all **TypeScript**, compiled by `tsc` to `dist/`, `dist-tests/`, `dist-scripts/` and `extension/sw.js`; the plugin entry only uses the host-provided `@deepseek-ai/dsh-tools` peer.
- **Your real login state.** Point it at a dedicated Chromium instance; sign in once and it persists. Your daily browser is never touched.
- **Text-first.** Accessibility-tree snapshots and refs beat screenshot-VLM loops; screenshots stay optional.
- **Per-task tab groups.** Tabs the harness creates are grouped per DSH session; work tabs are never grouped, and headless browsers skip grouping.
- **Reliable actions.** Snapshots are serialized per page, concurrent attaches share one session, clicks hit-test for overlays (`E_CLICK_INTERCEPTED`), `load` waits for complete, the first navigation is network-captured, and network idle uses active requests plus last-activity time.
- **Task lifecycle and tab locks.** Each DSH session is a Task; page operations hold an exclusive target lease, cross-task conflicts return `E_TAB_LOCKED`/`E_LOCK_TIMEOUT`, and `browser_task` supports status/pause/resume/close.
- **Tested.** 172 unit tests (fake CDP) + 38 integration scenarios (real headless/headful Chromium) = 210, with CI on three platforms.
- **Hardened boundaries.** `browser_tabs use` accepts only page targets with http(s)/about:blank URLs (non-owned tabs need an exact targetId); screenshots/PDF stay inside `screenshotDir` and never overwrite; uploads are confined to `uploadDir`, downloads to `downloadDir`, with symlink-escape checks; `fill` never echoes the entered value; JS mode is marked non-concurrent; token-like URLs/headers are redacted in tool output; broad port fallback is explicit `auto` only; tab grouping no longer mutates page titles.

## Requirements

| Requirement | Notes |
|---|---|
| DSH | `>=0.2.1-rc.5` (no upper bound) |
| Node | `>=22` |
| Browser | any Chromium-based browser with remote debugging (default 9331; see [configuration](docs/configuration.md)) |
| Platform | Windows / Linux verified; macOS unit CI passes, real Chromium E2E untested |

## Install

Published to **GitHub Packages** as `@xumi0920/dsh-browser-harness` (the same-named npmjs.org package is unrelated). Three options, details in **[docs/install.md](docs/install.md)**:

1. **Plugins page (recommended)**: DSH Web → Plugins → Add plugin → Install a third-party plugin. Accepts npm package names, Git repositories and local directories; marketplace entries live under the **Discover** tab.
2. **Ask DSH in one sentence** (Creator-mode session): `Install @xumi0920/dsh-browser-harness into the current profile`.
3. **Manual install (GitHub Packages, classic PAT)**:

```powershell
npm config set "@xumi0920:registry" "https://npm.pkg.github.com"
npm config set "//npm.pkg.github.com/:_authToken" "<YOUR_GITHUB_TOKEN>"
& "$env:LOCALAPPDATA\\Programs\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd" `
  plugin --profile desktop add "@xumi0920/dsh-browser-harness"
```

> The GitHub Packages npm registry **only supports classic PATs** (`read:packages`); fine-grained tokens do not work. A manual `npm config set` persists the token in `~/.npmrc`: prefer the one-click scripts (temporary config, deleted after install), or delete it with `npm config delete "//npm.pkg.github.com/:_authToken"` and revoke the token after installing. Build a local checkout with `npm install && npm run build` before installing it; exit DSH before changing the profile from the CLI. **Hot-plugging:** `application: applied` means it is already live; only `restart-required` needs a restart (replacing an installed package usually requires a restart to load the new JS module generation; see `restartReason`).

## Quick start

Once the install is live, start the dedicated Chromium browser (default 9331), then let the model call the tools in **any DSH session** (all presets work; Creator mode only matters for the `plugin_manager` install step):

```
browser_status → browser_navigate {url} → browser_snapshot → browser_act {action:"click", ref}
browser_extract {mode:"text" | "html" | "js" | "network" | "console" | "frames"}
```

`connected:false` on the first call? Make sure the dedicated browser is running and `http://127.0.0.1:9331/json/version` answers (see [docs/configuration.md](docs/configuration.md)).

## When to use it

| Situation | Recommendation |
|---|---|
| Logged-in pages, clicks/forms, downloads/uploads, multiple tabs, screenshots | use this plugin |
| Plain public reads | prefer `web_fetch` (faster, no browser) |
| Headless environment | tab groups are skipped automatically; other tools still work |
| Daily-driver browser | never point it there; use a dedicated profile instance |

## Docs

| Doc | Contents |
|---|---|
| [Install & verify](docs/install.md) | Plugins page / one sentence / GitHub Packages / local / Linux / uninstall / upgrade / FAQ |
| [Configuration](docs/configuration.md) | Browser discovery, ports, registry, profile-patch keys |
| [Tab groups](docs/tab-groups.md) | Behaviour, config, troubleshooting, implementation |
| [Usage](docs/usage.md) | DSH workflow, standalone library, CLI |
| [Architecture](docs/architecture.md) | Layers, flows, error model, safety boundaries |
| [Extending & languages](docs/extending.md) | Native JS/TS plugins, hot-plug/HMR, MCP for Python etc. |
| [Repository layout](docs/README.md) | Directory conventions, maintenance and release flow |

> The detailed `docs/` pages are written in Chinese; this English README mirrors their key points.
| [Security policy](SECURITY.md) | Private vulnerability reporting, supported versions, data handling |

## Extending & languages

- **Native plugins:** Node 22+ ESM packages (JS/TS, TS needs a build) registered through a bundle patch; HMR coordinates hot-plugging.
- **Other languages:** write an MCP server (stdio / Streamable HTTP; Python / Go / Rust / Node all work), add a `@deepseek-ai/dsh-mcp-client` entry to the profile, and its tools appear as `mcp__<serverName>__<tool>`.
- **Skills:** Markdown (`SKILL.md`); **UI plugins:** JS/TS. Details: [docs/extending.md](docs/extending.md).

## Tests & CI

```sh
npm install                 # dev deps (TypeScript); runtime stays zero-dependency
npm run test:all            # build + 172 unit + 38 integration = 210 tests
```

CI: unit on ubuntu / windows / macOS (plus a Node 24 job); integration on ubuntu + xvfb (27-scenario gate, S15/S16 must actually run). Tests and scripts are compiled by `tsc` too (`dist-tests/` / `dist-scripts/`), sharing the runtime NodeNext config.

## Safety

- Only tabs this harness created are closed; `force` needs the user's explicit agreement.
- `browser_tabs use` accepts only **page** targets with `http(s)`/`about:blank` URLs; non-owned tabs need an exact `targetId`, and URL substrings only match harness-owned tabs. `file:`/`chrome:`/extension workers are rejected.
- Screenshots are confined to `screenshotDir` (default `<stateDir>/screenshots`); directory escapes, symlinks and overwriting existing files are rejected.
- `browser_act fill` returns only `{ok, length, verified}` and never echoes the input; JS mode can mutate page state and is marked non-concurrent.
- Cookies are redacted by default; network URLs/headers and status/tab URLs get best-effort token redaction: query keys are matched after camelCase/kebab/snake-case normalization, and `Location` / `Content-Location` are redacted wholesale. Page content, HTML and screenshots may still contain sensitive data: not a full DLP.
- `browser_status` endpoint diagnostics omit full CDP URLs; connection errors keep only a stable error code and a safe hint.
- State stores URLs without query/fragment/userinfo; broad CDP port fallback requires explicit `browser: "auto"` / `BH_ALLOW_FALLBACK=1`.
- Never point `cdpUrl` at a daily-driver browser; background operations only; login walls stop the workflow and ask the user.

## License

MIT (c) 2026 Xumi0920 · current version **v1.6.0** · all code (sources, tests, scripts, extension) is TypeScript · see the [Releases page](https://github.com/Xumi0920/dsh-browser-harness/releases) for the changelog