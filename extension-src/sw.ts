/**
 * DSH browser-harness tab-group helper (MV3 service worker).
 *
 * The harness drives this worker over CDP: it attaches to this service worker
 * target and evaluates chrome.tabs / chrome.tabGroups calls. The listener below
 * is what lets Chrome restart this worker when the harness creates a tab; it
 * intentionally does no work of its own.
 */
chrome.tabs.onCreated.addListener(() => {
  /* wake marker: grouping is driven by the harness over CDP */
});
