#!/usr/bin/env node
/**
 * Standalone CLI over the core (no DSH required):
 *   bh doctor | tabs | open <url> | info | snapshot | text [sel] | js <expr> | shot [path] | close
 */

import { Browser } from "../src/browser.mjs";
import { listEndpoints } from "../src/cdp/endpoint.mjs";
import { snapshotToText } from "../src/ax.mjs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const [command, ...args] = process.argv.slice(2);

function stateDir() {
  return process.env.BH_STATE_DIR || join(process.env.DSH_HOME || process.env.HOME || tmpdir(), "browser-harness");
}

async function main() {
  if (!command || command === "help" || command === "--help") {
    console.log("usage: bh <doctor|tabs|open <url>|info|snapshot|text [selector]|js <expr>|shot [path]|close>");
    return;
  }
  if (command === "doctor") {
    const endpoints = await listEndpoints({});
    for (const endpoint of endpoints) {
      console.log(endpoint.id + "\tport=" + endpoint.port + "\t" + endpoint.status + (endpoint.browser ? "\t" + endpoint.browser : ""));
    }
    return;
  }
  const browser = await Browser.connect({ stateDir: stateDir(), lane: "cli" });
  try {
    if (command === "tabs") {
      for (const tab of await browser.listTabs()) console.log(tab.targetId + "\t" + tab.title + "\t" + tab.url);
      return;
    }
    if (command === "open") {
      const page = await browser.open(args[0] || "about:blank");
      const info = await page.info();
      console.log(info.url + "\t" + info.title);
      return;
    }
    const current = await browser.current();
    if (!current) throw new Error("no current tab; run: bh open <url>");
    const page = await browser.attach(current.targetId);
    if (command === "info") console.log(JSON.stringify(await page.info(), null, 2));
    else if (command === "snapshot") console.log(snapshotToText(await page.snapshot(), { maxLines: 200 }));
    else if (command === "text") console.log(await page.text(args[0]));
    else if (command === "js") console.log(JSON.stringify(await page.evaluate(args.join(" ")), null, 2));
    else if (command === "shot") console.log(JSON.stringify(await page.screenshot({ path: args[0], fullPage: args.includes("--full") }), null, 2));
    else throw new Error("unknown command: " + command);
  } finally {
    browser.close();
  }
}

main().catch((error) => {
  console.error((error && error.code ? error.code + ": " : "") + (error && error.message ? error.message : error));
  process.exit(1);
});
