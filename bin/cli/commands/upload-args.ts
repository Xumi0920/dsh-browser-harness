import { rejectUnknownFlags } from "./common.js";

const FLAGS = ["ref", "selector", "path", "paths"];

export function parseUploadArgs(positional: string[], flags: any) {
  rejectUnknownFlags(flags, FLAGS, "upload");
  if (positional.length > 0) throw new Error("upload accepts no positional arguments");
  if (flags.ref && flags.selector) throw new Error("upload accepts --ref or --selector, not both");
  if (!flags.ref && !flags.selector) throw new Error("upload needs --ref or --selector");
  if (flags.path !== undefined && flags.paths !== undefined) throw new Error("upload cannot use both --path and --paths");
  const paths = flags.paths !== undefined
    ? String(flags.paths).split(",").map((value) => value.trim()).filter(Boolean)
    : flags.path !== undefined ? [String(flags.path).trim()] : [];
  if (paths.length === 0 || paths.some((value) => !value)) throw new Error("upload needs a non-empty --path or --paths");
  return { ref: flags.ref, selector: flags.selector, paths };
}
