# dsh-browser-harness

[简体中文](README.md) | **English**

**Native browser tools for DeepSeek Harness (DSH).** A zero-dependency CDP core exposes seven `browser_*` tools that drive a *dedicated, already-running* Chromium-based browser with real login state, return compact accessibility snapshots with clickable refs (e1, e2, ...), and group harness-created tabs per task.

```
browser_status      endpoint, browser version, tabs, current tab
browser_navigate    open a URL, return info + snapshot
browser_snapshot    compact refs (e1 ...) with role/name/viewport center
browser_act         click / type / fill / press / scroll
browser_extract     text / html / JS / network
browser_screenshot  PNG path
browser_tabs        list / use / new / close
```

## Highlights

- **Zero dependencies.** Node 22+ built-ins only (`fetch`, `WebSocket`, `node:test`); no browser download, no build step. The DSH plugin entry only uses the host-provided `@deepseek-ai/dsh-tools` peer.
- **Your logged-in browser.** Point it at a dedicated Chromium instance (Chrome / Chromium / Edge / Brave / Vivaldi / Opera / Arc); sign in once and it persists.
- **Text-first.** Accessibility-tree snapshots and refs beat screenshot-VLM loops for actions; screenshots stay optional.
- **Per-task tab groups.** Tabs the harness creates are grouped by DSH session; work tabs are never touched, and headless browsers skip grouping.
- **Tested.** 90 unit tests + 27 integration scenarios = 117, all against real headless/headful Chromium.

## Install

Published to **GitHub Packages** as `@xumi0920/dsh-browser-harness` (the same-named npmjs.org package is an unrelated project). Pick one way to install.

**Easiest: ask DSH to install it in one sentence** (Creator-mode session; `plugin_manager` is a Creator-mode tool and each operation needs danger-full-access or per-call approval):

> Install `@xumi0920/dsh-browser-harness` into the current DSH profile.

For a local checkout, use the absolute path instead of the package name: `Install <path-to-your-clone> into the current profile`.

**Or install manually (GitHub Packages):**

```powershell
npm config set @xumi0920:registry https://npm.pkg.github.com
npm config set //npm.pkg.github.com/:_authToken "<YOUR_GITHUB_TOKEN>"
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
  plugin --profile desktop add "@xumi0920/dsh-browser-harness"
```

Local checkout, Linux / macOS, one-click scripts, verify and uninstall: see **[docs/install.md](docs/install.md)**.

## Quick start

Once installed, let the model call the tools in **any DSH session** (all presets; Creator mode only affects the `plugin_manager` install step):

```
browser_status → browser_navigate {url} → browser_snapshot → browser_act {action:"click", ref}
browser_extract {mode:"text" | "html" | "js" | "network"}
```

Standalone library / CLI examples: [docs/usage.md](docs/usage.md). Starting the dedicated browser, ports and config: [docs/configuration.md](docs/configuration.md).

## Docs

| Doc | Contents |
|---|---|
| [Install & verify](docs/install.md) | One-sentence DSH install / GitHub Packages / local / Linux / uninstall / upgrade / FAQ |
| [Configuration](docs/configuration.md) | Browser discovery, port conventions, registry, profile-patch keys |
| [Per-task tab groups](docs/tab-groups.md) | Behaviour and boundaries, config, troubleshooting, implementation |
| [Usage](docs/usage.md) | DSH workflow, standalone library, CLI |
| [Architecture](docs/architecture.md) | Layers, flows, error model, safety boundaries |
| [Repository layout](docs/README.md) | Directory conventions, maintenance and release flow |

## Test

```sh
npm test                    # unit (no browser)
npm run test:integration    # 27 integration scenarios
npm run test:all            # unit + integration (117 tests)
```

CI: unit on ubuntu/windows; integration on ubuntu (xvfb, including the headful tab-group scenario).

## Safety

- Only tabs this harness created are closed; `force` needs the user's explicit agreement.
- Cookie values are redacted by default and the harness never logs secrets; note that `browser_status` / `browser_tabs` echo tab URLs that may embed tokens.
- Page data is only returned when explicitly requested; never point `cdpUrl` at a daily-driver browser.
- Background operations only; login walls stop the workflow and ask the user.

## Status

v0.3.3: the install docs gained a "let DSH install it in one sentence" option, and the quick start now states that once installed every preset can use the tools (`plugin_manager` is only needed for the install step, in Creator mode). Behaviour is unchanged from v0.3.1. See the [Releases page](https://github.com/Xumi0920/dsh-browser-harness/releases) for the changelog.

MIT (c) 2026 Xumi0920
