import { rejectUnknownFlags } from "./common.js";

export const EXTRACT_MODES = ["text", "html", "js", "network", "console", "frames"];

const FLAGS_BY_MODE: Record<string, string[]> = {
  text: ["selector", "frame-id", "frame-url"],
  html: ["selector", "frame-id", "frame-url"],
  js: ["expression", "frame-id"],
  network: ["include-body", "url-contains"],
  console: [],
  frames: [],
};

export function validateExtractFlags(mode: string, flags: any) {
  rejectUnknownFlags(flags, FLAGS_BY_MODE[mode] || [], "extract " + mode);
}
