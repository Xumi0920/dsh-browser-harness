---
name: browser-harness
description: "Drive a dedicated real Chromium-based browser (Chrome, Chromium, Edge, Brave, Vivaldi, Opera, Arc, ...) via browser_* tools (CDP): navigate, accessibility snapshot with refs, click/type/fill, extract data, screenshot. Use for interactive or logged-in pages; use web_fetch for plain public reads."
whenToUse: "When a task needs a real browser: clicking through flows, filling forms, reading JS-rendered or login-gated pages, inspecting visual layout, or reusing an existing signed-in session."
---

# browser-harness

Operate a real, already-running Chromium-based automation browser through the `browser_*` tools. It has its own persistent profile and login state; it is not a fetch proxy and not the user's daily browser. Any Chromium-based browser works as long as it exposes a CDP endpoint (Chrome, Chromium, Edge, Brave, Vivaldi, Opera, Arc, ...).

## When not to use

A plain public read needs no browser. If `web_fetch` can read it, use `web_fetch`. Escalate to the browser when the task needs interaction, a logged-in session, JS rendering, or a visual check.

## Workflow

1. `browser_status` — confirm the CDP endpoint, browser version, current tab.
2. `browser_navigate {url}` — opens the URL, returns page info plus a compact snapshot. Use `action:"back"|"forward"|"reload"` for history navigation.
3. Choose a ref (`e1`, `e2`, ...) from the snapshot.
4. `browser_wait` — wait for selector appear/disappear, text/URL changes, response completion, network-idle or delay instead of re-snapshotting in a loop.
5. `browser_act` — `{action:"click"|"hover"|"highlight", ref}`, `{action:"drag", ref, toRef|toSelector}`, `{action:"fill", selector, text}`, `{action:"type", ref, text}`, `{action:"selectOption", selector, values}`, `{action:"check"|"uncheck", ref}`, `{action:"press", key:"Enter"}`, `{action:"scroll", dy:400}`, `{action:"dialog", accept}`; optional `expectUrl`/`expectText`/`expectSelector` fail with `E_EXPECTATION_FAILED` when the post-action state is wrong.
6. Verify: `browser_snapshot` again, or `browser_extract {mode:"text"}` / `{mode:"js", expression}` / `{mode:"console"}`. For iframes, list with `{mode:"frames"}`, snapshot with `browser_snapshot {frameId}`, then act on the returned refs.
7. Screenshot with `browser_screenshot` (optionally `ref`/`selector` for an element) when layout or visual state matters; `browser_pdf` exports PDF. Files stay in `screenshotDir` and existing files are never overwritten.
8. Upload with `browser_upload {ref|selector, path|paths}`; paths must be inside `uploadDir`. Download with `browser_download {ref|selector}`; files land in `downloadDir`.
9. On failure or ambiguity, call `browser_diagnose` for a screenshot, console errors, failed responses and active requests; then close tabs you created with `browser_tabs {action:"close", targetId}`.
10. Use `browser_task` to inspect or control the current task: status, pause, resume, close, start (after close). Page operations hold an exclusive tab lease; another task on the same tab gets `E_TAB_LOCKED` or `E_LOCK_TIMEOUT`.

## Rules

- **Refs expire.** A ref belongs to the snapshot that produced it. After navigation, dynamic rendering, or any DOM change, take a new snapshot before acting.
- **Coordinates are CSS pixels; screenshots are device pixels.** Never copy coordinates measured in a screenshot.
- **Drag has two modes.** `browser_act {action:"drag"}` defaults to a real mouse sequence for pointer/mouse draggable UIs. Add `mode:"html5"` for native `draggable`/`DataTransfer` drop zones; it dispatches synthetic drag events with a DataTransfer. Use custom click flows for components that respond to neither.
- **Snapshot pagination covers the full filtered set.** `role`/`name` filtering happens before pagination; `offset`/`limit` can walk past 400 and `total` reports the full filtered count. Pass the returned `generation` when requesting another page in the same process to keep refs stable; a stale generation fails with `E_STALE_SNAPSHOT`. Separate CLI invocations have no shared in-memory generation cache.
- **Read-only mode.** When `readOnly: true`, browser_act, JS extraction, upload/download, tab create/close and task mutations fail with `E_READ_ONLY`; use navigation, snapshot, extraction and screenshots for inspection. It does not make GET navigation side-effect-free.
- **Form controls are stateful.** Use `selectOption` for native selects, and `check`/`uncheck` idempotently; do not blindly click a checkbox twice (that toggles it back). Read the resulting value with `browser_extract {mode:"js"}` when correctness matters.
- **Controlled inputs need fill.** `browser_act {action:"fill"}` focuses the field, clears it with real Ctrl+A / Backspace key presses, writes the whole value once with `Input.insertText`, then dispatches `input`/`change`, so React/Vue controlled components stay in sync. It returns only `{ok, length, verified}` and never echoes the value. It is not per-character typing; use `type` only when keystroke semantics matter.
- **JS mode has side effects.** `browser_extract {mode:"js"}` evaluates arbitrary page JavaScript with user-gesture semantics; it can mutate the DOM, submit forms or make requests and is marked non-concurrent. Use it only when a fixed read cannot answer the question.
- **Iframes need an explicit frame.** Use `browser_extract {mode:"frames"}` then `browser_snapshot {frameId}`; refs from that snapshot work with click/fill/type. `browser_extract {mode:"js", frameId}` runs inside the child frame.
- **Stay in the background.** Do not ask to bring the browser to the foreground; the harness works behind the scenes.
- **Touch only tabs you created.** Closing is restricted to harness-owned tabs; a non-owned tab fails with `E_POLICY_DENIED`. Never force-close a user tab. `browser_tabs {action:"use"}` accepts only page targets with http(s)/about:blank URLs; a non-owned tab requires its exact `targetId`, and URL substrings match only harness-owned tabs. Tab grouping now matches the newest ungrouped tab by URL and never mutates `document.title`.
- **Files have fixed roots.** `browser_upload` reads only `uploadDir`; `browser_download` writes only `downloadDir`; screenshots/PDFs write only `screenshotDir`. Ask the user to place files in the relevant directory instead of bypassing the confinement.
- **Login walls:** stop and ask the user. Never enter credentials you were not given.
- **No secrets:** do not print cookies, tokens, or passwords. Tool output redacts token-like URL query values and response headers, but page text/HTML/screenshots are not DLP-protected; avoid operating on sensitive pages you were not asked to use.
- **Non-owned tabs need explicit borrow.** `browser_tabs {action:"use", targetId, borrow:true}` after confirming with the user; tabs owned by another Task return `E_TAB_OWNER_CONFLICT`. Never close a borrowed user tab.
- **One active task per tab.** Page operations hold an exclusive target lease. Do not retry a busy tab in a tight loop; inspect `browser_task status` / `browser_tabs list`, wait, or use a different tab. Pausing a task releases its leases; closing it closes its owned tabs by default.
- **One browser lane:** serialize browser actions; two workflows fighting over the tab pointer race.

## Failure handling

| code | meaning | next step |
|---|---|---|
| `E_NO_BROWSER` | no reachable CDP endpoint | ask the user to start the dedicated Chromium browser (e.g. Chrome on 9331, Edge on 9332), or configure `browser`/`cdpUrl` |
| `E_NO_TAB` | no current tab | call `browser_navigate` first |
| `E_SELECTOR_TIMEOUT` / `E_ELEMENT_NOT_FOUND` | element missing or ref stale | re-snapshot, use a fresh ref or a CSS selector |
| `E_POLICY_DENIED` | unsafe target (file/internal page, non-owned URL match), screenshot path outside `screenshotDir`, or closing a tab the harness did not create | ask the user; force-close only after they explicitly agree |
| `E_NO_DIALOG` | `dialog` action was called with no open dialog (for example under auto-dismiss) | re-check the page state; use `dialogPolicy:"manual"` when confirmations need a decision |
| `E_CLICK_INTERCEPTED` | another element covers the click target, or the target is disabled | close/dismiss the overlay, re-snapshot, or retry with `force:true` only if you deliberately accept the overlay |
| `E_DIALOG_OPEN` | JS dialog blocking | dialogs auto-dismiss by default; retry once |
| `E_TIMEOUT` | operation exceeded its budget | check `browser_status`, reduce scope, retry |

## Tips

- SPA pages: after navigate, immediate snapshot may be too early; snapshot/extract again until the target text appears.
- Long pages: prefer snapshot refs (they include viewport centers) over guessing selectors.
- Network: `browser_extract {mode:"network"}` returns the current tab's most recent request events since the connection (up to 100); set `includeBody:true` to attach response bodies (slower). URLs/headers get best-effort token redaction; bodies are not redacted.
- Tab groups: by default the tabs this harness creates are grouped per task (`DSH · <session>`). User/work tabs are never moved, renamed, closed or grouped. Disable with config `tabGroups: false`; grouping is skipped in headless browsers.
- Downloads, uploads and cookies are intentionally out of the current tool surface; use the library (`dist/src/index.js`, after `npm run build`) or a CLI script for those.
