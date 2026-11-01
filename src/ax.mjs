/**
 * Accessibility-tree helpers: turn CDP AX nodes into compact, clickable refs.
 *
 * A snapshot gives the model role + name + bbox center in CSS pixels, which is
 * exactly what coordinate clicks need and what a text model can reason about.
 */

/** Roles worth exposing to a model that wants to act on a page. */
export const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "switch",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "treeitem",
  "slider",
  "spinbutton",
  "gridcell",
  "cell",
  "columnheader",
  "rowheader",
  "listitem",
  "heading",
]);

const TEXT_ROLES = new Set(["StaticText", "staticText", "paragraph", "LabelText"]);

function axValue(node, key) {
  const value = node && node[key];
  if (!value) return undefined;
  if (typeof value === "object" && "value" in value) return value.value;
  return undefined;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Compute center + size from a DOM.getBoxModel quad (8 numbers, 4 corners).
 * @param {{ content?: number[] }} model
 * @returns {{ x: number, y: number, width: number, height: number } | null}
 */
export function boxCenter(model) {
  const quad = model && Array.isArray(model.content) ? model.content : null;
  if (!quad || quad.length !== 8) return null;
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const x = xs.reduce((sum, value) => sum + value, 0) / 4;
  const y = ys.reduce((sum, value) => sum + value, 0) / 4;
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  return { x: round2(x), y: round2(y), width: round2(width), height: round2(height) };
}

/**
 * Build a compact snapshot from Accessibility.getFullAXTree nodes.
 * @param {any[]} nodes AX nodes from Accessibility.getFullAXTree
 * @param {{
 *   maxNodes?: number,
 *   roles?: string[] | Set<string>,
 *   includeText?: boolean,
 *   boxes?: Map<number, any>,
 *   refStart?: number,
 * }} [options]
 * @returns {{ nodes: Array<{ref: string, role: string, name: string, value?: unknown, disabled?: boolean, backendDOMNodeId: number, center?: {x:number,y:number}, size?: {width:number,height:number}}>, truncated: boolean, total: number }}
 */
export function buildSnapshot(nodes, options = {}) {
  const maxNodes = options.maxNodes ?? 400;
  const roleSet = options.roles ? new Set(options.roles) : INTERACTIVE_ROLES;
  const boxes = options.boxes;
  const refStart = Number.isFinite(options.refStart) ? Number(options.refStart) : 0;
  const out = [];
  let matched = 0;
  for (const node of nodes || []) {
    if (!node || node.ignored) continue;
    const role = String((node.role && node.role.value) || "");
    if (!role) continue;
    const isInteractive = roleSet.has(role);
    const isText = Boolean(options.includeText) && TEXT_ROLES.has(role);
    if (!isInteractive && !isText) continue;
    if (typeof node.backendDOMNodeId !== "number") continue;
    matched += 1;
    if (out.length >= maxNodes) continue;
    const name = String(axValue(node, "name") ?? "").replace(/\s+/g, " ").trim();
    const value = axValue(node, "value");
    const box = boxes ? boxes.get(node.backendDOMNodeId) : undefined;
    const center = box ? boxCenter(box) : null;
    /** @type {Record<string, unknown>} */
    const row = {
      ref: "e" + (refStart + out.length + 1),
      role,
      name,
      backendDOMNodeId: node.backendDOMNodeId,
    };
    if (value !== undefined && value !== null && value !== "") row.value = typeof value === "object" ? safeJson(value) : value;
    if (node.properties) {
      const properties = node.properties;
      if (Array.isArray(properties)) {
        for (const property of properties) {
          if (property && property.name === "disabled" && property.value && property.value.value === true) row.disabled = true;
          if (property && property.name === "checked" && property.value && typeof property.value.value === "string") row.checked = property.value.value;
        }
      }
    }
    if (center) {
      row.center = { x: center.x, y: center.y };
      row.size = { width: center.width, height: center.height };
    }
    out.push(row);
  }
  return { nodes: out, truncated: matched > out.length, total: matched };
}

function safeJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

/**
 * Find a ref by its label (case-sensitive, e.g. "e12").
 * @param {any[]} snapshotNodes
 * @param {string} ref
 */
export function findRef(snapshotNodes, ref) {
  return (snapshotNodes || []).find((node) => node.ref === ref) ?? null;
}

/**
 * Find nodes by role and/or a case-insensitive name substring.
 * @param {any[]} snapshotNodes
 * @param {{ role?: string, name?: string, exact?: boolean }} query
 */
export function findByRole(snapshotNodes, query = {}) {
  const wanted = query.name ? String(query.name).toLowerCase() : null;
  return (snapshotNodes || []).filter((node) => {
    if (query.role && node.role !== query.role) return false;
    if (wanted === null) return true;
    const name = String(node.name ?? "").toLowerCase();
    return query.exact ? name === wanted : name.includes(wanted);
  });
}

/** Default cap on rendered snapshot lines (snapshot nodes may be capped higher). */
export const MAX_SNAPSHOT_TEXT_LINES = 200;

/** Render one snapshot node as a compact model-readable line. */
export function snapshotLine(node) {
  const parts = [node.ref, node.role];
  if (node.name) parts.push(JSON.stringify(node.name));
  if (node.value !== undefined && node.value !== null && node.value !== "") parts.push("value=" + JSON.stringify(node.value));
  if (node.disabled) parts.push("disabled");
  if (node.center) parts.push("@" + node.center.x + "," + node.center.y);
  return parts.join(" ");
}

/**
 * Render a snapshot as text plus an authoritative truncation flag.
 *
 * The flag is true when the accessibility layer cut nodes *or* the text line
 * cap hid some of the nodes that were kept, so callers never report a short
 * text as complete.
 *
 * @param {{ nodes: any[], truncated?: boolean, total?: number }} snapshot
 * @param {{ maxLines?: number }} [options]
 * @returns {{ text: string, truncated: boolean, shown: number }}
 */
export function formatSnapshot(snapshot, options = {}) {
  const maxLines = options.maxLines ?? MAX_SNAPSHOT_TEXT_LINES;
  const nodes = (snapshot && snapshot.nodes) || [];
  const shown = nodes.slice(0, maxLines);
  const truncated = Boolean(snapshot && snapshot.truncated) || nodes.length > shown.length;
  const lines = shown.map(snapshotLine);
  if (truncated) {
    const total = Math.max(nodes.length, Number(snapshot && snapshot.total) || 0);
    lines.push("... snapshot truncated (" + shown.length + " of " + total + " nodes)");
  }
  return { text: lines.join("\n"), truncated, shown: shown.length };
}

/**
 * Render a snapshot as compact text lines for a model.
 * @param {{ nodes: any[], truncated?: boolean, total?: number }} snapshot
 * @param {{ maxLines?: number }} [options]
 */
export function snapshotToText(snapshot, options = {}) {
  return formatSnapshot(snapshot, options).text;
}
