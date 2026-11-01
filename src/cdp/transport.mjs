/**
 * Minimal CDP transport over a WebSocket, zero dependencies.
 *
 * Dependency-injectable for tests: pass `WebSocketImpl` to exercise request
 * matching, event routing, timeouts, and close handling without a browser.
 */

import { cdpError, cdpTimeout, codes, connectTimeout, HarnessError, notConnected } from "../errors.mjs";

const DEFAULT_TIMEOUT_MS = 15_000;

/** Tiny emitter with unsubscribe handles. */
class Emitter {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map();
  }
  on(event, handler) {
    if (typeof handler !== "function") throw new TypeError("handler must be a function");
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(handler);
    return () => this.off(event, handler);
  }
  off(event, handler) {
    this.listeners.get(event)?.delete(handler);
  }
  emit(event, ...args) {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(...args);
      } catch {
        /* listener failures must not break the transport */
      }
    }
  }
}

export class CDPTransport extends Emitter {
  /**
   * @param {string} wsUrl
   * @param {{ WebSocketImpl?: any, defaultTimeoutMs?: number, logger?: { debug?: Function, warn?: Function } }} [options]
   */
  constructor(wsUrl, options = {}) {
    super();
    if (typeof wsUrl !== "string" || wsUrl.length === 0) throw new HarnessError(codes.E_BAD_ARG, "CDPTransport needs a ws:// URL");
    this.wsUrl = wsUrl;
    this.WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.logger = options.logger ?? {};
    /** @type {any} */
    this.ws = null;
    this.nextId = 1;
    /** @type {Map<number, { resolve: Function, reject: Function, timer: any, method: string }>} */
    this.pending = new Map();
    this.closed = false;
    this.ready = false;
  }

  connect() {
    if (this.ws) return Promise.reject(new HarnessError(codes.E_BAD_ARG, "connect() called twice"));
    const Impl = this.WebSocketImpl;
    if (typeof Impl !== "function") {
      return Promise.reject(notConnected("no WebSocket implementation available (Node 22+ or pass WebSocketImpl)"));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new Impl(this.wsUrl);
      this.ws = ws;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch { /* ignore */ }
        reject(connectTimeout(this.wsUrl, this.defaultTimeoutMs));
      }, this.defaultTimeoutMs);

      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(this);
      };

      ws.addEventListener("open", () => {
        this.ready = true;
        this.logger.debug?.("cdp transport open", this.wsUrl);
        finish(null);
      });
      ws.addEventListener("message", (event) => this.#onMessage(event));
      ws.addEventListener("error", (event) => {
        const message = (event && (event.message || (event.error && event.error.message))) || "websocket error";
        if (!this.ready) finish(notConnected(`CDP websocket error: ${message}`));
        this.emit("error", event);
      });
      ws.addEventListener("close", (event) => {
        this.#onClose(event);
        if (!this.ready) finish(notConnected("CDP websocket closed before it opened"));
      });
    });
  }

  #onMessage(event) {
    let raw = "";
    try {
      const data = event && event.data;
      if (typeof data === "string") raw = data;
      else if (data && typeof data.toString === "function") raw = data.toString("utf8");
      if (!raw) return;
      this.#dispatch(JSON.parse(raw));
    } catch (error) {
      this.logger.warn?.("ignoring malformed CDP message", String(error).slice(0, 200));
    }
  }

  #dispatch(message) {
    if (typeof message.id === "number") {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(cdpError(entry.method, message.error, { sessionId: message.sessionId }));
      else entry.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method === "string") {
      this.emit(message.method, message.params ?? {}, message.sessionId);
      this.emit("event", message);
    }
  }

  #onClose(event) {
    this.closed = true;
    this.ready = false;
    const reason = event && (event.reason || event.code) ? ` (code ${event.code}${event.reason ? ": " + event.reason : ""})` : "";
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(notConnected(`CDP connection closed while waiting for ${entry.method}${reason}`));
    }
    this.pending.clear();
    this.emit("close", event);
  }

  /**
   * Send one CDP command.
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @param {{ sessionId?: string, timeoutMs?: number }} [options]
   */
  send(method, params = {}, options = {}) {
    if (typeof method !== "string" || method.length === 0) {
      return Promise.reject(new HarnessError(codes.E_BAD_ARG, "CDP method must be a non-empty string"));
    }
    if (this.closed || !this.ws) return Promise.reject(notConnected(`cannot send ${method}: CDP connection is not open`));
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    /** @type {Record<string, unknown>} */
    const payload = { id, method, params };
    if (options.sessionId) payload.sessionId = options.sessionId;
    let json;
    try {
      json = JSON.stringify(payload);
    } catch (error) {
      return Promise.reject(new HarnessError(codes.E_BAD_ARG, `cannot serialize params for ${method}: ${String(error)}`));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(cdpTimeout(method, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.ws.send(json);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(notConnected(`cannot write to CDP socket: ${String(error)}`));
      }
    });
  }

  onEvent(method, handler) {
    return this.on(method, handler);
  }

  /**
   * Resolve on the next matching event.
   * @param {string} method
   * @param {((params: any, sessionId?: string) => boolean) | undefined} predicate
   * @param {number} [timeoutMs]
   */
  waitForEvent(method, predicate, timeoutMs = this.defaultTimeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(cdpTimeout(method + " (event)", timeoutMs));
      }, timeoutMs);
      const off = this.onEvent(method, (params, sessionId) => {
        let matched = true;
        if (typeof predicate === "function") {
          try { matched = Boolean(predicate(params, sessionId)); } catch { matched = false; }
        }
        if (!matched) return;
        clearTimeout(timer);
        off();
        resolve({ params, sessionId });
      });
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.ws?.close(); } catch { /* ignore */ }
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(notConnected(`CDP connection closed while waiting for ${entry.method}`));
    }
    this.pending.clear();
  }
}

/** Connect and resolve a ready transport. */
export function connectTransport(wsUrl, options) {
  const transport = new CDPTransport(wsUrl, options);
  return transport.connect();
}
