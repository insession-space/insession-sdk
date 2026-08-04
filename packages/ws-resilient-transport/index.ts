// ws-resilient-transport — a tiny, dependency-free WebSocket transport that
// reconnects itself the way a production deployment actually needs it to.
//
// It grew out of InSession's realtime sync layer, where every client is dropped
// at once on each deploy. The behaviour that matters:
//   - A configurable "service restart" close code reconnects almost immediately
//     (the new instance is already accepting connections behind a healthcheck),
//     instead of waiting out an exponential backoff.
//   - Every other drop uses exponential backoff capped at a maximum.
//   - Every wait is jittered (±jitterRatio) so a fleet of clients cut at the
//     same millisecond does not stampede the new instance (thundering herd).
//   - Configurable "terminal" close codes stop reconnection entirely (the
//     server has said it will never accept this connection again).
//
// It is generic over the message types, uses JSON by default, and lets you
// inject the WebSocket implementation (for Node or tests), the timers, and the
// RNG (for deterministic tests). No runtime dependencies.

// readyState values from the WHATWG WebSocket spec. Kept as local constants so
// the transport does not depend on static members of the injected impl.
const CONNECTING = 0;
const OPEN = 1;

/** The subset of the WHATWG `WebSocket` interface this transport relies on. */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror?: ((ev: unknown) => void) | null;
}

export type WebSocketConstructor = new (url: string) => WebSocketLike;

// A timer handle. `setTimeout` returns `number` in browsers and `Timeout` in
// Node; accept either so the transport stays environment-agnostic.
export type TimerHandle = number | ReturnType<typeof setTimeout>;

export interface Timers {
  setTimeout: (handler: () => void, ms: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
}

export interface ResilientWebSocketOptions<TSend = unknown, TRecv = unknown> {
  /** WebSocket endpoint to connect to. */
  url: string;

  /** Called with every parsed inbound message. */
  onMessage: (msg: TRecv) => void;

  /**
   * Builds the first message to send once a connection opens (e.g. an auth /
   * join handshake). Return `null` (or throw) to send nothing.
   *
   * `resumedFromServiceRestart` is `true` only when the *previous* disconnect
   * used `serviceRestartCode` — i.e. this open is the fast reconnect after a
   * deploy. Use it to tell the server "I was already here" so it can suppress
   * re-join side effects. It is `false` on the first connect and after any
   * non-service-restart drop.
   */
  buildOpenMessage?: (ctx: {
    resumedFromServiceRestart: boolean;
  }) => TSend | Record<string, unknown> | null | Promise<TSend | Record<string, unknown> | null>;

  /** Called right before a reconnect is scheduled (e.g. to show a status). */
  onReconnecting?: () => void;

  /**
   * Guard checked before reconnecting and before delivering messages. Return
   * `false` after teardown (e.g. React unmount) to stop the transport from
   * reconnecting or firing callbacks. Defaults to always-active.
   */
  isActive?: () => boolean;

  /** Base backoff for the first non-service-restart reconnect. Default 500ms. */
  reconnectDelay?: number;
  /** Upper bound on backoff. Default 15000ms. */
  maxReconnectDelay?: number;

  /**
   * Close code that means "the server is restarting, come straight back"
   * (RFC 6455 1012 Service Restart is the conventional choice). The first
   * reconnect after this code waits `serviceRestartDelay` instead of backing
   * off. Set to `null` to disable the fast path. Default `null`.
   */
  serviceRestartCode?: number | null;
  /** Delay for the fast reconnect after `serviceRestartCode`. Default 250ms. */
  serviceRestartDelay?: number;

  /**
   * Close codes on which the transport must NOT reconnect — the server has
   * ended this connection for good. Default `[]`.
   */
  terminalCloseCodes?: readonly number[];

  /** Fraction of jitter applied to every wait, e.g. 0.3 → ±30%. Default 0.3. */
  jitterRatio?: number;

  /** Serialize outbound messages. Default `JSON.stringify`. */
  serialize?: (msg: TSend | Record<string, unknown>) => string;
  /** Parse inbound message data. Default `JSON.parse`. */
  deserialize?: (data: string) => TRecv;

  /** WebSocket implementation. Default `globalThis.WebSocket`. */
  WebSocket?: WebSocketConstructor;
  /** Timer functions, injectable for tests. Default global set/clearTimeout. */
  timers?: Timers;
  /** RNG in [0, 1), injectable for deterministic tests. Default `Math.random`. */
  random?: () => number;
}

export interface ResilientWebSocket<TSend = unknown> {
  /** Open the connection. Idempotent while connecting/open. */
  connect: () => void;
  /** Send a message if the socket is open; dropped silently otherwise. */
  send: (msg: TSend | Record<string, unknown>) => void;
  /** Close permanently and cancel any pending reconnect. */
  close: () => void;
  /** The current underlying socket, or `null`. */
  socket: () => WebSocketLike | null;
}

/**
 * Create a self-reconnecting WebSocket transport. See
 * {@link ResilientWebSocketOptions} for the knobs.
 */
export function createResilientWebSocket<TSend = unknown, TRecv = unknown>(
  options: ResilientWebSocketOptions<TSend, TRecv>,
): ResilientWebSocket<TSend> {
  const {
    url,
    onMessage,
    buildOpenMessage,
    onReconnecting,
    isActive = () => true,
    reconnectDelay = 500,
    maxReconnectDelay = 15000,
    serviceRestartCode = null,
    serviceRestartDelay = 250,
    terminalCloseCodes = [],
    jitterRatio = 0.3,
    serialize = JSON.stringify,
    deserialize = JSON.parse,
    WebSocket: WebSocketImpl = globalThis.WebSocket as unknown as WebSocketConstructor,
    random = Math.random,
  } = options;

  // Wrap the globals so the default matches `Timers` regardless of whether the
  // ambient `setTimeout` return type is `number` (DOM) or `Timeout` (Node).
  const timers: Timers = options.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  };

  if (!WebSocketImpl) {
    throw new Error(
      '@insession/ws-resilient-transport: no WebSocket implementation. Pass options.WebSocket in environments without a global WebSocket.',
    );
  }

  const terminal = new Set(terminalCloseCodes);

  let ws: WebSocketLike | null = null;
  let reconnectTimer: TimerHandle | null = null;
  // Consecutive failed attempts. Reset to 0 whenever a connection opens.
  let attempt = 0;
  // Whether the previous disconnect used serviceRestartCode. Passed to the next
  // single `buildOpenMessage` and then cleared.
  let resumeFromRestart = false;

  // Apply ±jitterRatio to a wait so simultaneously-dropped clients spread out.
  function jitter(ms: number) {
    return Math.round(ms * (1 - jitterRatio + random() * jitterRatio * 2));
  }

  // Next reconnect wait: the fast path for the first service-restart reconnect,
  // exponential backoff otherwise. Both jittered.
  function nextDelay(code: number | undefined) {
    if (serviceRestartCode != null && code === serviceRestartCode && attempt === 1) {
      return jitter(serviceRestartDelay);
    }
    const backoff = Math.min(reconnectDelay * 2 ** (attempt - 1), maxReconnectDelay);
    return jitter(backoff);
  }

  function connect() {
    // Cancel a pending reconnect; do nothing if a live socket already exists.
    if (reconnectTimer) timers.clearTimeout(reconnectTimer);
    if (ws && (ws.readyState === CONNECTING || ws.readyState === OPEN)) return;

    const sock = new WebSocketImpl(url);
    ws = sock;

    sock.onopen = async () => {
      // A fresh connection resets backoff.
      attempt = 0;
      // Consume the resume flag for this open only.
      const resumedFromServiceRestart = resumeFromRestart;
      resumeFromRestart = false;
      if (!buildOpenMessage) return;
      let openMsg: TSend | Record<string, unknown> | null = null;
      try {
        openMsg = await buildOpenMessage({ resumedFromServiceRestart });
      } catch {
        openMsg = null;
      }
      if (openMsg != null && sock.readyState === OPEN) sock.send(serialize(openMsg));
    };

    sock.onmessage = (event) => {
      if (!isActive()) return;
      onMessage(deserialize(event.data as string));
    };

    sock.onclose = (event) => {
      // Ignore closes for a socket we already replaced, or after teardown.
      if (!isActive() || ws !== sock) return;
      // Terminal close: the server will not accept this connection again.
      if (event?.code != null && terminal.has(event.code)) {
        ws = null;
        return;
      }
      // Mark the next open as a service-restart resume.
      if (serviceRestartCode != null && event?.code === serviceRestartCode) {
        resumeFromRestart = true;
      }
      attempt += 1;
      onReconnecting?.();
      reconnectTimer = timers.setTimeout(() => {
        if (isActive()) connect();
      }, nextDelay(event?.code));
    };
  }

  function send(msg: TSend | Record<string, unknown>) {
    if (ws && ws.readyState === OPEN) ws.send(serialize(msg));
  }

  function close() {
    if (reconnectTimer) timers.clearTimeout(reconnectTimer);
    const sock = ws;
    ws = null;
    try {
      sock?.close();
    } catch {
      /* noop */
    }
  }

  function socket() {
    return ws;
  }

  return { connect, send, close, socket };
}
