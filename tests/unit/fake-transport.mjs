/**
 * Scripted CDP transport double for Browser/Page/Manager unit tests.
 * No network, no Chrome: every send() is recorded and answered by a handler.
 */
export class FakeTransport {
  constructor() {
    /** @type {{ method: string, params: any, options: any }[]} */
    this.calls = [];
    this.handlers = new Map();
    this.listeners = new Map();
    this.closed = false;
    this.sessionSeq = 0;
  }

  /** Answer one CDP method. */
  on(method, handler) {
    this.handlers.set(method, handler);
    return this;
  }

  async send(method, params = {}, options = {}) {
    this.calls.push({ method, params, options });
    const handler = this.handlers.get(method);
    if (handler) return handler(params, options);
    return {};
  }

  onEvent(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
    return () => this.listeners.get(method)?.delete(handler);
  }

  emit(method, params = {}, sessionId) {
    for (const handler of [...(this.listeners.get(method) || [])]) handler(params, sessionId);
  }

  listenerCount(method) {
    return (this.listeners.get(method) || new Set()).size;
  }

  count(method) {
    return this.calls.filter((call) => call.method === method).length;
  }

  methods() {
    return this.calls.map((call) => call.method);
  }

  close() {
    this.closed = true;
  }
}

/** A box-model answer with a stable viewport rectangle. */
export function quad(x = 0, y = 0, width = 20, height = 10) {
  return { model: { content: [x, y, x + width, y, x + width, y + height, x, y + height] } };
}
