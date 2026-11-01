/**
 * DSH plugin entry: registers the browser_* tools and embeds the skill.
 *
 * Loaded by the Cordis loader from the bundle patch (cordis.patch.yml).
 * The factory lives in ./plugin.ts so it can be tested without the host peer.
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import { createApply, inject, name } from "./plugin.js";

export { inject, name };

export const apply = createApply({ defineTool });

export default { name, inject, apply };
