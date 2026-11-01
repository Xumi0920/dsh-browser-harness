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

- **Zero runtime dependencies.** The built output uses only Node 22+ built-ins (`fetch`, `WebSocket`, `node:test`) and no browser download. The **source is TypeScript**, compiled to `dist/` with `tsc`; dev dependencies are just `typescript` + `@types/node`, and the DSH plugin entry only uses the host-provided `@deepseek-ai/dsh-tools` peer.
- **Your logged-in browser.** Point it at a dedicated Chromium instance (Chrome / Chromium / Edge / Brave / Vivaldi / Opera / Arc); sign in once and it persists.
- **Text-first.** Accessibility-tree snapshots and refs beat screenshot-VLM loops for actions; screenshots stay optional.
- **Per-task tab groups.** Tabs the harness creates are grouped by DSH session; work tabs are never touched, and headless browsers skip grouping.
- **Tested.** 96 unit tests (fake CDP double, no browser) + 27 integration scenarios (real headless/headful Chromium) = 123.

## Install

Published to **GitHub Packages** as `@xumi0920/dsh-browser-harness` (the same-named npmjs.org package is an unrelated project); it needs **DSH 0.2.1-rc.5 + Node 22**. Pick one way to install.

**Option 1 (recommended, GUI): the DSH Web plugin page**

Open the **Plugins page** in the DSH Web UI (the "Plugins" entry in the left navigation/settings; the session menu's "Browse more plugins" also gets there), then in the **Installed** tab click **Add plugin** → **Install a third-party plugin**. It accepts **npm package names, Git repositories and local directories**; marketplace entries can be installed from the **Discover** tab.

**Option 2: ask DSH to install it in one sentence** (Creator-mode session; `plugin_manager` is a Creator-mode tool and each operation needs danger-full-access or per-call approval):

> Install `@xumi0920/dsh-browser-harness` into the current DSH profile.

> The GitHub Packages source **requires the two npm config commands from option 3 first** (a read:packages token). To skip the token, use the absolute path of a local checkout instead: `Install <path-to-your-clone> into the current profile` (run `npm install && npm run build` in the checkout first — the source is TypeScript).

**Option 3: manual install (GitHub Packages / CLI)**

```powershell
npm config set "@xumi0920:registry" "https://npm.pkg.github.com"
npm config set "//npm.pkg.github.com/:_authToken" "<YOUR_GITHUB_TOKEN>"
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
  plugin --profile desktop add "@xumi0920/dsh-browser-harness"
```

> Exit DeepSeek Harness before changing the profile from the CLI, then restart it. Local checkout, Linux / macOS, one-click scripts (token only in a temporary npm config), verify and uninstall: see **[docs/install.md](docs/install.md)**.

**Hot-plugging:** when the install result has `application: "applied"` the change is already live — no restart. Only `restart-required` needs a restart, and `restartReason` explains why (`no-hmr` / `package-moved` / `host-module` / `unmanaged-plugin` / `module-comparison`). **Replacing an installed package** (upgrade, moved directory, edited local link checkout) normally needs a restart to load a fresh JavaScript module generation; the Web UI shows "restart DSH to apply the change" with the reason.

## Quick start

Once the install is live (`applied` or after a required restart), start the dedicated Chromium browser (ports and launch commands: [docs/configuration.md](docs/configuration.md); default 9331). Then let the model call the tools in **any DSH session** (all presets; Creator mode only affects the `plugin_manager` install step):

```
browser_status → browser_navigate {url} → browser_snapshot → browser_act {action:"click", ref}
browser_extract {mode:"text" | "html" | "js" | "network"}
```

Standalone library / CLI examples: [docs/usage.md](docs/usage.md). Starting the dedicated browser, ports and config: [docs/configuration.md](docs/configuration.md).

## Docs

| Doc | Contents |
|---|---|
| [Install & verify](docs/install.md) | Plugins page / one-sentence DSH install / GitHub Packages / local / Linux / uninstall / upgrade / FAQ |
| [Configuration](docs/configuration.md) | Browser discovery, port conventions, registry, profile-patch keys |
| [Per-task tab groups](docs/tab-groups.md) | Behaviour and boundaries, config, troubleshooting, implementation |
| [Usage](docs/usage.md) | DSH workflow, standalone library, CLI |
| [Architecture](docs/architecture.md) | Layers, flows, error model, safety boundaries |
| [Extending & languages](docs/extending.md) | Plugin language, hot-plug/HMR, MCP for Python and other languages |
| [Repository layout](docs/README.md) | Directory conventions, maintenance and release flow |

## Extending & languages

- **Native plugins:** Node 22+ ESM packages (JS/TS; TypeScript needs a build step) registered through a bundle patch; hot-plugging is coordinated by DSH's HMR.
- **Other languages:** write an MCP server (stdio or Streamable HTTP; Python / Go / Rust / Node all work), add a `@deepseek-ai/dsh-mcp-client` entry to the profile, and its tools appear as `mcp__<serverName>__<tool>`.
- **Skills:** Markdown (`SKILL.md`), no code. **UI plugins:** JS/TS (DSH Web Client).
- Why JS/TS for plugins: it is the module language of the host runtime (Node 22 / V8) — the model does not "run JavaScript" itself; zero-build JS or TS is simply the easiest way for an agent to author a plugin. Python's data/ML ecosystem fits better through MCP. Details: [docs/extending.md](docs/extending.md).

## Test

```sh
npm install                 # dev deps (TypeScript build); runtime stays zero-dependency
npm test                    # build + 96 unit tests (no browser)
npm run test:integration    # build + 27 integration scenarios
npm run test:all            # build + unit + integration (123 tests)
```

CI: unit on ubuntu/windows; integration on ubuntu (xvfb, including the headful tab-group scenario).

## Safety

- Only tabs this harness created are closed; `force` needs the user's explicit agreement.
- Cookie values are redacted by default and the harness never logs secrets; note that `browser_status` / `browser_tabs` echo tab URLs that may embed tokens.
- Page data is only returned when explicitly requested; never point `cdpUrl` at a daily-driver browser.
- Background operations only; login walls stop the workflow and ask the user.

## Status

v0.4.1: type-safety and stability — `tsconfig` now enables `strict` (with `noImplicitAny` staged); the tab-group bridge re-attaches after the MV3 service worker dies; `browser_navigate` only reuses the current tab when the harness owns it; the plugin entry was split into a testable `createApply` factory (+4 unit tests, 96 + 27 = 123). Since v0.4.0 the source is TypeScript compiled to `dist/` with `tsc`, and the runtime stays zero-dependency. See the [Releases page](https://github.com/Xumi0920/dsh-browser-harness/releases) for the changelog.

MIT (c) 2026 Xumi0920
