import { assertNavigableUrl } from "../../../src/browser.js";
import { booleanFlag, rejectUnknownFlags } from "./common.js";

const ACTIONS = ["list", "new", "use", "close"];

export function parseTabsArgs(positional: string[], flags: any) {
  const action = String(positional[0] || "list");
  if (!ACTIONS.includes(action)) throw new Error("tabs needs one of: " + ACTIONS.join(", "));
  if (action === "list") {
    rejectUnknownFlags(flags, [], "tabs list");
    if (positional.length > 1) throw new Error("tabs list accepts no arguments");
    return { action, tab: null, url: null, borrow: false, force: false };
  }
  if (action === "new") {
    rejectUnknownFlags(flags, [], "tabs new");
    if (positional.length > 2) throw new Error("tabs new accepts at most one URL");
    const url = positional[1] ? String(positional[1]).trim() : "about:blank";
    assertNavigableUrl(url);
    return { action, tab: null, url, borrow: false, force: false };
  }
  if (action === "use") {
    rejectUnknownFlags(flags, ["borrow"], "tabs use");
    if (positional.length !== 2 || !positional[1]) throw new Error("tabs use needs exactly one targetId");
    return { action, tab: positional[1], url: null, borrow: booleanFlag(flags.borrow, "--borrow"), force: false };
  }
  rejectUnknownFlags(flags, ["force"], "tabs close");
  if (positional.length > 2) throw new Error("tabs close accepts at most one targetId");
  return { action, tab: positional[1] || null, url: null, borrow: false, force: booleanFlag(flags.force, "--force") };
}
