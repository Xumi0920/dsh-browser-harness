/**
 * Public entry point.
 *
 * ```js
 * import { connect } from "./src/index.mjs";
 * const bh = await connect({ browser: "chrome" });
 * const page = await bh.newTab("https://example.com");
 * console.log(await page.info(), await page.snapshot());
 * bh.close();
 * ```
 */

export { Browser, Page } from "./browser.mjs";
export { resolveEndpoint, listEndpoints, probeVersion, readRegistry, registryPath, defaultDshHome, DEFAULT_PORTS } from "./cdp/endpoint.mjs";
export { buildSnapshot, boxCenter, findByRole, findRef, snapshotToText, INTERACTIVE_ROLES } from "./ax.mjs";
export * as state from "./state.mjs";
export * as errors from "./errors.mjs";
export { HarnessError, codes } from "./errors.mjs";

/** Connect to a running browser; shorthand for `Browser.connect`. */
export async function connect(options = {}) {
  return (await import("./browser.mjs")).Browser.connect(options);
}

/**
 * Run `fn` against a connected browser and always close the connection.
 * @template T
 * @param {object} options
 * @param {(browser: import("./browser.mjs").Browser) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withBrowser(options, fn) {
  const browser = await connect(options);
  try {
    return await fn(browser);
  } finally {
    browser.close();
  }
}
