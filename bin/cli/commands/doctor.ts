import { listEndpoints } from "../../../src/cdp/endpoint.js";
import type { CliCommand } from "../registry.js";
import { rejectAllArgs } from "./common.js";

export const doctorCommand: CliCommand = {
  name: "doctor",
  needsBrowser: false,
  usage: "doctor — list known CDP endpoints and browser status",
  async run(_ctx, positional, flags) {
    rejectAllArgs(positional, flags, "doctor");
    const endpoints = await listEndpoints({});
    for (const endpoint of endpoints as any[]) {
      console.log(endpoint.id + "\tport=" + endpoint.port + "\t" + endpoint.status + (endpoint.browser ? "\t" + endpoint.browser : ""));
    }
  },
};
