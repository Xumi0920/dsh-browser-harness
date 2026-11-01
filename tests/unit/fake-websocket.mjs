/**
 * A scripted WebSocket stand-in for transport tests. No network, no browser.
 */
export class FakeWebSocket {
  static instances = [];
  static script = () => {};
  static defaultOpenDelay = 0;

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.listeners = new Map();
    FakeWebSocket.instances.push(this);
    setTimeout(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.#emit("open", {});
    }, FakeWebSocket.defaultOpenDelay);
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }
  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }
  #emit(type, event) {
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event);
  }
  send(data) {
    if (this.readyState !== 1) throw new Error("fake socket is not open");
    const message = JSON.parse(data);
    this.sent.push(message);
    FakeWebSocket.script(this, message);
  }
  /** Deliver a server -> client frame. */
  deliver(message) {
    this.#emit("message", { data: JSON.stringify(message) });
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.#emit("close", { code: 1000, reason: "closed" });
  }
  fail(error = new Error("boom")) {
    this.#emit("error", { error, message: error.message });
  }
  static reset() {
    FakeWebSocket.instances = [];
    FakeWebSocket.script = () => {};
    FakeWebSocket.defaultOpenDelay = 0;
  }
}
