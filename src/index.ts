/**
 * Public entry point.
 *
 * ```js
 * import { connect } from "./src/index.js";
 * const bh = await connect({ browser: "chrome" });
 * const page = await bh.newTab("https://example.com");
 * console.log(await page.info(), await page.snapshot());
 * bh.close();
 * ```
 */

export { Browser, Page } from "./browser.js";
export { resolveEndpoint, listEndpoints, probeVersion, readRegistry, registryPath, defaultDshHome, DEFAULT_PORTS } from "./cdp/endpoint.js";
export { buildSnapshot, boxCenter, findByRole, findRef, snapshotToText, INTERACTIVE_ROLES } from "./ax.js";
export * as state from "./state.js";
export * as errors from "./errors.js";
export { HarnessError, codes } from "./errors.js";

/** Connect to a running browser; shorthand for `Browser.connect`. */
export async function connect(options: any = {} as any) {
  return (await import("./browser.js")).Browser.connect(options);
}

/**
 * Run `fn` against a connected browser and always close the connection.
 * @template T
 * @param {object} options
 * @param {(browser: import("./browser.js").Browser) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withBrowser(options: any, fn: any) {
  const browser = await connect(options);
  try {
    return await fn(browser);
  } finally {
    browser.close();
  }
}
