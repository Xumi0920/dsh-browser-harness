import { rejectUnknownFlags } from "./common.js";

export const ACT_ACTIONS = ["click", "hover", "highlight", "drag", "type", "fill", "selectOption", "check", "uncheck", "press", "scroll", "dialog"];

const EXPECT_FLAGS = ["expect-url", "expect-text", "expect-selector", "expect-timeout-ms"];

const FLAGS_BY_ACTION: Record<string, string[]> = {
  click: ["ref", "selector", "x", "y", "button", "clicks", "force"],
  hover: ["ref", "selector"],
  highlight: ["ref", "selector"],
  drag: ["ref", "selector", "to-ref", "to-selector", "steps", "mode"],
  type: ["ref", "selector", "text"],
  fill: ["ref", "selector", "text"],
  selectOption: ["ref", "selector", "values"],
  check: ["ref", "selector"],
  uncheck: ["ref", "selector"],
  press: ["key", "modifiers"],
  scroll: ["dx", "dy"],
  dialog: ["accept", "dismiss", "prompt-text"],
};

export function validateActFlags(action: string, flags: any) {
  rejectUnknownFlags(flags, [...(FLAGS_BY_ACTION[action] || []), ...EXPECT_FLAGS], "act " + action);
}
