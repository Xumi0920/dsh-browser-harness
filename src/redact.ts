/**
 * Output redaction helpers shared by the tool layer, the manager and CDP
 * endpoint diagnostics. Internal connection values stay untouched; only values
 * that may reach model-visible output or error text are sanitized here.
 */

// Query keys are normalized (lowercase, separators removed) before matching so
// accessToken / access-token / ACCESS_TOKEN / %61ccessToken all match. Keep this
// a finite canonical set: substring rules would also redact monkey/tokenizer.
const SENSITIVE_QUERY = /^(token|accesstoken|refreshtoken|idtoken|session|sessionid|sid|auth|authorization|password|passwd|secret|apikey|key|code)$/i;
// Location / Content-Location carry redirect URLs that may themselves contain
// credentials; conservatively redact the whole value (case-insensitive).
const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|location|content-location|x[-_].*(token|secret|session|auth|key).*)$/i;
const URL_IN_TEXT = /\b(?:https?|wss?):\/\/[^\s<>"'\`]+/gi;

/** Strip credentials and sensitive query values before a URL enters tool output. */
export function redactUrlForOutput(raw: any) {
  const text = String(raw || "");
  if (!text) return raw;
  try {
    const url = new URL(text);
    let changed = false;
    if (url.username) { url.username = "redacted"; changed = true; }
    if (url.password) { url.password = "redacted"; changed = true; }
    for (const [key, value] of [...url.searchParams.entries()]) {
      const normalizedKey = key.toLowerCase().replace(/[-_\s]/g, "");
      if (SENSITIVE_QUERY.test(normalizedKey) || /(token|secret|session|password|authorization)/i.test(value)) {
        url.searchParams.set(key, "[redacted]");
        changed = true;
      }
    }
    if (url.hash) { url.hash = "#redacted"; changed = true; }
    return changed ? url.toString() : text;
  } catch {
    return text;
  }
}

/** Redact credential-carrying response/request headers. */
export function redactHeadersForOutput(headers: any) {
  if (!headers || typeof headers !== "object") return headers;
  const out: any = {};
  for (const [key, value] of Object.entries(headers)) out[key] = SENSITIVE_HEADER.test(key) ? "[redacted]" : value;
  return out;
}

/** Redact URLs embedded in free-form error text (fails closed on parse errors). */
export function redactTextForOutput(raw: any) {
  const text = String(raw ?? "");
  return text.replace(URL_IN_TEXT, (match) => {
    try {
      const url = new URL(match);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      return "[redacted-url]";
    }
  });
}

/** Safe endpoint identity for diagnostics: protocol + host:port, no path/credentials. */
export function safeEndpointLabel(raw: any) {
  try {
    const url = new URL(String(raw));
    return url.protocol + "//" + url.host;
  } catch {
    return "[configured CDP endpoint]";
  }
}
