/**
 * Harness error taxonomy.
 *
 * Public API failures carry a stable machine `code` (E_*), a readable message,
 * and optional JSON-safe details, so a tool wrapper or an agent can branch and
 * retry without parsing prose.
 */

export class HarnessError extends Error {
  code: string;
  details: Record<string, any>;
  cause?: any;
  /**
   * @param {string} code stable code, one of `codes`
   * @param {string} message human readable
   * @param {{ cause?: unknown, details?: Record<string, unknown> }} [extra]
   */
  constructor(code: any, message: any, extra: any = {} as any) {
    super(message);
    this.name = "HarnessError";
    this.code = code;
    /** @type {Record<string, unknown>} */
    this.details = extra.details ?? {};
    if (extra.cause !== undefined) this.cause = extra.cause;
  }
  toJSON() {
    return { ok: false, code: this.code, message: this.message, details: this.details };
  }
}

export const codes = Object.freeze({
  E_BAD_ARG: "E_BAD_ARG",
  E_NOT_CONNECTED: "E_NOT_CONNECTED",
  E_NO_BROWSER: "E_NO_BROWSER",
  E_CONNECT_TIMEOUT: "E_CONNECT_TIMEOUT",
  E_TIMEOUT: "E_TIMEOUT",
  E_CDP: "E_CDP",
  E_TARGET_CLOSED: "E_TARGET_CLOSED",
  E_STALE_TARGET: "E_STALE_TARGET",
  E_NO_TAB: "E_NO_TAB",
  E_ELEMENT_NOT_FOUND: "E_ELEMENT_NOT_FOUND",
  E_CLICK_INTERCEPTED: "E_CLICK_INTERCEPTED",
  E_TAB_LOCKED: "E_TAB_LOCKED",
  E_TAB_OWNER_CONFLICT: "E_TAB_OWNER_CONFLICT",
  E_TAB_BORROW_REQUIRED: "E_TAB_BORROW_REQUIRED",
  E_LOCK_TIMEOUT: "E_LOCK_TIMEOUT",
  E_LEASE_FAILED: "E_LEASE_FAILED",
  E_L2_UNSUPPORTED: "E_L2_UNSUPPORTED",
  E_TASK_PAUSED: "E_TASK_PAUSED",
  E_TASK_CLOSING: "E_TASK_CLOSING",
  E_TASK_CLOSED: "E_TASK_CLOSED",
  E_SELECTOR_TIMEOUT: "E_SELECTOR_TIMEOUT",
  E_DIALOG_OPEN: "E_DIALOG_OPEN",
  E_FRAME_NOT_FOUND: "E_FRAME_NOT_FOUND",
  E_DOWNLOAD_FAILED: "E_DOWNLOAD_FAILED",
  E_UPLOAD_FAILED: "E_UPLOAD_FAILED",
  E_POLICY_DENIED: "E_POLICY_DENIED",
  E_EVAL: "E_EVAL",
});

export function badArgument(message: any, details: any = {} as any) {
  return new HarnessError(codes.E_BAD_ARG, message, { details });
}
export function notConnected(message: any = "browser connection is not open") {
  return new HarnessError(codes.E_NOT_CONNECTED, message);
}
export function noBrowser(message: any, details: any = {} as any) {
  return new HarnessError(codes.E_NO_BROWSER, message, { details });
}
export function connectTimeout(wsUrl: any, timeoutMs: any) {
  return new HarnessError(codes.E_CONNECT_TIMEOUT, `CDP connect timed out after ${timeoutMs}ms`, {
    details: { wsUrl, timeoutMs },
  });
}
export function cdpError(method: any, error: any, details: any = {} as any) {
  const message = error && error.message ? error.message : String(error);
  return new HarnessError(codes.E_CDP, `CDP ${method} failed: ${message}`, {
    cause: error,
    details: { method, ...(error && error.data ? { data: error.data } : {}), ...details },
  });
}
export function cdpTimeout(method: any, timeoutMs: any) {
  return new HarnessError(codes.E_TIMEOUT, `CDP ${method} timed out after ${timeoutMs}ms`, {
    details: { method, timeoutMs },
  });
}
export function waitTimeout(what: any, timeoutMs: any, details: any = {} as any) {
  return new HarnessError(codes.E_TIMEOUT, `timed out after ${timeoutMs}ms while waiting for ${what}`, {
    details: { what, timeoutMs, ...details },
  });
}
export function targetGone(targetId: string, message?: string) {
  return new HarnessError(codes.E_TARGET_CLOSED, message ?? `target ${targetId} no longer exists`, {
    details: { targetId },
  });
}
export function staleTarget(targetId: string, message?: string) {
  return new HarnessError(codes.E_STALE_TARGET, message ?? `target ${targetId} is stale; call open() again`, {
    details: { targetId },
  });
}
export function noTab(message: any = "no page tab is available; call open(url) first") {
  return new HarnessError(codes.E_NO_TAB, message);
}
export function elementNotFound(selector: any, details: any = {} as any) {
  return new HarnessError(codes.E_ELEMENT_NOT_FOUND, `element not found: ${selector}`, { details: { selector, ...details } });
}
export function clickIntercepted(message: any, details: any = {} as any) {
  return new HarnessError(codes.E_CLICK_INTERCEPTED, message, { details });
}
export function selectorTimeout(selector: any, timeoutMs: any, details: any = {} as any) {
  return new HarnessError(codes.E_SELECTOR_TIMEOUT, `waiting for ${JSON.stringify(selector)} timed out after ${timeoutMs}ms`, {
    details: { selector, timeoutMs, ...details },
  });
}
export function dialogOpen(dialog: any) {
  return new HarnessError(codes.E_DIALOG_OPEN, `a ${dialog?.type ?? "javascript"} dialog is open: ${String(dialog?.message ?? "").slice(0, 200)}`, {
    details: { dialog },
  });
}
export function evalFailure(expression: any, error: any) {
  return new HarnessError(codes.E_EVAL, `page evaluation failed: ${error && error.message ? error.message : String(error)}`, {
    cause: error,
    details: { expression: String(expression).slice(0, 800) },
  });
}
export function policyDenied(message: any, details: any = {} as any) {
  return new HarnessError(codes.E_POLICY_DENIED, message, { details });
}
export function frameNotFound(what: any) {
  return new HarnessError(codes.E_FRAME_NOT_FOUND, `frame not found: ${what}`, { details: { frame: what } });
}
export function downloadFailed(message: any, details: any = {} as any) {
  return new HarnessError(codes.E_DOWNLOAD_FAILED, message, { details });
}
export function uploadFailed(message: any, details: any = {} as any) {
  return new HarnessError(codes.E_UPLOAD_FAILED, message, { details });
}
export function asHarnessError(error: any, fallback: any = "unexpected harness failure") {
  if (error instanceof HarnessError) return error;
  if (error instanceof Error) return new HarnessError(codes.E_EVAL, error.message || fallback, { cause: error });
  return new HarnessError(codes.E_EVAL, fallback, { details: { value: String(error) } });
}