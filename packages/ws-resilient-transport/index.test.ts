// Run with: node --test packages/ws-resilient-transport
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createResilientWebSocket,
  type Timers,
  type WebSocketConstructor,
  type WebSocketLike,
} from './index.ts';

// A controllable fake WebSocket + a manual timer queue, so every test is
// deterministic (no real sockets, no wall-clock waits, no RNG).
class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0; // CONNECTING
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closedWith: number | undefined;
  url: string;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code?: number) {
    this.closedWith = code;
    this.readyState = 3; // CLOSED
  }

  // Test helpers ----------------------------------------------------------
  open() {
    this.readyState = 1; // OPEN
    this.onopen?.(undefined);
  }
  receive(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  serverClose(code?: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

function harness() {
  FakeSocket.instances = [];
  const pending: Array<{ fn: () => void; ms: number }> = [];
  const timers: Timers = {
    setTimeout: (fn, ms) => {
      pending.push({ fn, ms });
      return pending.length;
    },
    clearTimeout: () => {},
  };
  return {
    WebSocket: FakeSocket as unknown as WebSocketConstructor,
    timers,
    // random fixed to 0.5 → jitter multiplier is exactly 1 (no scaling)
    random: () => 0.5,
    flushTimers() {
      const queued = pending.splice(0);
      for (const t of queued) t.fn();
    },
    lastDelay() {
      return pending[pending.length - 1]?.ms;
    },
    get instances() {
      return FakeSocket.instances;
    },
  };
}

test('sends the open message on connect and forwards parsed messages', async () => {
  const h = harness();
  const received: unknown[] = [];
  const rt = createResilientWebSocket({
    url: 'ws://x',
    WebSocket: h.WebSocket,
    timers: h.timers,
    random: h.random,
    buildOpenMessage: () => ({ type: 'join', resume: false }),
    onMessage: (m) => received.push(m),
  });
  rt.connect();
  const sock = h.instances[0];
  sock.open();
  await Promise.resolve(); // buildOpenMessage awaits a microtask
  assert.deepEqual(JSON.parse(sock.sent[0]), { type: 'join', resume: false });

  sock.receive({ type: 'chat', text: 'hi' });
  assert.deepEqual(received, [{ type: 'chat', text: 'hi' }]);
});

test('send() only writes when the socket is open', () => {
  const h = harness();
  const rt = createResilientWebSocket({
    url: 'ws://x',
    WebSocket: h.WebSocket,
    timers: h.timers,
    random: h.random,
    onMessage: () => {},
  });
  rt.connect();
  const sock = h.instances[0];
  rt.send({ type: 'ping' }); // still CONNECTING → dropped
  assert.equal(sock.sent.length, 0);
  sock.open();
  rt.send({ type: 'ping' });
  assert.deepEqual(JSON.parse(sock.sent[0]), { type: 'ping' });
});

test('reconnects with exponential backoff on a normal close', () => {
  const h = harness();
  const rt = createResilientWebSocket({
    url: 'ws://x',
    WebSocket: h.WebSocket,
    timers: h.timers,
    random: h.random,
    reconnectDelay: 500,
    onMessage: () => {},
  });
  rt.connect();
  h.instances[0].open();
  h.instances[0].serverClose(1006);
  assert.equal(h.lastDelay(), 500); // attempt 1 → base delay (jitter ×1)
  h.flushTimers();
  assert.equal(h.instances.length, 2); // reconnected
  h.instances[1].serverClose(1006);
  assert.equal(h.lastDelay(), 1000); // attempt 2 → 500 * 2^1
});

test('service-restart code triggers the fast reconnect and resume flag', async () => {
  const h = harness();
  const resumeSeen: boolean[] = [];
  const rt = createResilientWebSocket({
    url: 'ws://x',
    WebSocket: h.WebSocket,
    timers: h.timers,
    random: h.random,
    serviceRestartCode: 1012,
    serviceRestartDelay: 250,
    buildOpenMessage: ({ resumedFromServiceRestart }) => {
      resumeSeen.push(resumedFromServiceRestart);
      return { type: 'join' };
    },
    onMessage: () => {},
  });
  rt.connect();
  h.instances[0].open();
  await Promise.resolve();
  h.instances[0].serverClose(1012);
  assert.equal(h.lastDelay(), 250); // fast path, not 500 backoff
  h.flushTimers();
  h.instances[1].open();
  await Promise.resolve();
  assert.deepEqual(resumeSeen, [false, true]); // first connect false, resume true
});

test('terminal close codes stop reconnection', () => {
  const h = harness();
  const rt = createResilientWebSocket({
    url: 'ws://x',
    WebSocket: h.WebSocket,
    timers: h.timers,
    random: h.random,
    terminalCloseCodes: [4001],
    onMessage: () => {},
  });
  rt.connect();
  h.instances[0].open();
  h.instances[0].serverClose(4001);
  h.flushTimers();
  assert.equal(h.instances.length, 1); // no reconnect
  assert.equal(rt.socket(), null);
});

test('close() cancels reconnection and drops the socket', () => {
  const h = harness();
  const rt = createResilientWebSocket({
    url: 'ws://x',
    WebSocket: h.WebSocket,
    timers: h.timers,
    random: h.random,
    onMessage: () => {},
  });
  rt.connect();
  h.instances[0].open();
  rt.close();
  assert.equal(h.instances[0].closedWith, undefined); // closed without a code
  assert.equal(rt.socket(), null);
});

test('isActive() gate stops message delivery and reconnection after teardown', () => {
  const h = harness();
  let alive = true;
  const received: unknown[] = [];
  const rt = createResilientWebSocket({
    url: 'ws://x',
    WebSocket: h.WebSocket,
    timers: h.timers,
    random: h.random,
    isActive: () => alive,
    onMessage: (m) => received.push(m),
  });
  rt.connect();
  const sock = h.instances[0];
  sock.open();
  alive = false;
  sock.receive({ type: 'late' });
  assert.equal(received.length, 0); // gated out
  sock.serverClose(1006);
  h.flushTimers();
  assert.equal(h.instances.length, 1); // did not reconnect
});
