---
name: browser-harness
description: "Drive a dedicated real Chrome via browser_* tools (CDP): navigate, accessibility snapshot with refs, click/type/fill, extract data, screenshot. Use for interactive or logged-in pages; use web_fetch for plain public reads."
whenToUse: "When a task needs a real browser: clicking through flows, filling forms, reading JS-rendered or login-gated pages, inspecting visual layout, or reusing an existing signed-in session."
---

# browser-harness

Operate a real, already-running automation Chrome through the `browser_*` tools. It has its own persistent profile and login state; it is not a fetch proxy and not the user's daily browser.

## When not to use

A plain public read needs no browser. If `web_fetch` can read it, use `web_fetch`. Escalate to the browser when the task needs interaction, a logged-in session, JS rendering, or a visual check.

## Workflow

1. `browser_status` — confirm the CDP endpoint, Chrome version, current tab.
2. `browser_navigate {url}` — opens the URL, returns page info plus a compact snapshot.
3. Choose a ref (`e1`, `e2`, ...) from the snapshot.
4. `browser_act` — `{action:"click", ref}`, `{action:"fill", selector, text}`, `{action:"press", key:"Enter"}`, `{action:"scroll", dy:400}`.
5. Verify: `browser_snapshot` again, or `browser_extract {mode:"text"}` / `{mode:"js", expression}`.
6. Screenshot with `browser_screenshot` when layout or visual state matters.
7. Close tabs you created: `browser_tabs {action:"close", targetId}`.

## Rules

- **Refs expire.** A ref belongs to the snapshot that produced it. After navigation, dynamic rendering, or any DOM change, take a new snapshot before acting.
- **Coordinates are CSS pixels; screenshots are device pixels.** Never copy coordinates measured in a screenshot.
- **Controlled inputs need fill.** `browser_act {action:"fill"}` focuses the field, clears it with real Ctrl+A / Backspace key presses, writes the whole value once with `Input.insertText`, then dispatches `input`/`change`, so React/Vue controlled components stay in sync. It is not per-character typing; use `type` only when keystroke semantics matter.
- **Stay in the background.** Do not ask to bring Chrome to the foreground; the harness works behind the scenes.
- **Touch only tabs you created.** Closing is restricted to harness-owned tabs; a non-owned tab fails with `E_POLICY_DENIED`. Never force-close a user tab.
- **Login walls:** stop and ask the user. Never enter credentials you were not given.
- **No secrets:** do not print cookies, tokens, or passwords. Note that `browser_status` / `browser_tabs` return tab URLs verbatim, and a URL may embed a token.
- **One browser lane:** serialize browser actions; two workflows fighting over the tab pointer race.

## Failure handling

| code | meaning | next step |
|---|---|---|
| `E_NO_BROWSER` | no reachable CDP endpoint | ask the user to start the dedicated Chrome (9331), or configure `cdpUrl` |
| `E_NO_TAB` | no current tab | call `browser_navigate` first |
| `E_SELECTOR_TIMEOUT` / `E_ELEMENT_NOT_FOUND` | element missing or ref stale | re-snapshot, use a fresh ref or a CSS selector |
| `E_POLICY_DENIED` | tried to close a tab this harness did not create | ask the user; force-close (`bh close --force`, or the library's `force: true`) only after they explicitly agree |
| `E_DIALOG_OPEN` | JS dialog blocking | dialogs auto-dismiss by default; retry once |
| `E_TIMEOUT` | operation exceeded its budget | check `browser_status`, reduce scope, retry |

## Tips

- SPA pages: after navigate, immediate snapshot may be too early; snapshot/extract again until the target text appears.
- Long pages: prefer snapshot refs (they include viewport centers) over guessing selectors.
- Network: `browser_extract {mode:"network"}` returns the current tab's most recent request events since the connection (up to 100); set `includeBody:true` to attach response bodies (slower).
- Downloads, uploads and cookies are intentionally out of the v0.1 tool surface; use the library (`src/index.mjs`) or a CLI script for those.
