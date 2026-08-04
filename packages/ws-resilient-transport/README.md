# ws-resilient-transport

A tiny (~130 LOC), **dependency-free** WebSocket transport that reconnects the
way a production deployment actually needs it to.

Most reconnecting-WebSocket libraries give you generic backoff. The thing that
bites you in production is different: on every deploy, **every client is dropped
at the same instant**. You want those clients back *immediately* (the new server
instance is already up behind a healthcheck), but you do **not** want thousands
of them reconnecting on the same millisecond and stampeding it. And when the
server closes a connection for good, you want reconnection to actually stop.

This transport handles exactly that:

- **Fast reconnect on service restart** — a configurable close code (RFC 6455
  `1012 Service Restart` is the conventional choice) reconnects after a short
  fixed delay instead of waiting out a backoff.
- **Jittered exponential backoff** on every other drop, capped at a maximum.
  Every wait carries ±`jitterRatio` of randomness so a fleet cut at once spreads
  out (no thundering herd).
- **Terminal close codes** — a set of codes on which the transport stops
  reconnecting entirely (the server has said it will never accept this
  connection again).
- **Resume signal** — the first reconnect after a service restart tells your
  handshake `resumedFromServiceRestart: true`, so the server can suppress
  re-join side effects (re-broadcasting presence, etc.).

Generic over message types, JSON by default, and fully injectable (WebSocket
implementation, timers, RNG) for Node and deterministic tests.

## Install

```sh
npm install @insession/ws-resilient-transport
```

Published as a built ESM package (`dist/index.js` + `dist/index.d.ts`), no
runtime dependencies. (Previously this lived inside the InSession monorepo and
was vendored as a source module; see "Origin" below.)

## Usage

```ts
import { createResilientWebSocket } from '@insession/ws-resilient-transport';

type ClientMsg = { type: string; [k: string]: unknown };
type ServerMsg = { type: string; [k: string]: unknown };

let alive = true;

const transport = createResilientWebSocket<ClientMsg, ServerMsg>({
  url: 'wss://example.com/ws',

  // Sent as soon as each connection opens (auth / join handshake).
  buildOpenMessage: async ({ resumedFromServiceRestart }) => {
    const token = await getIdToken();
    return { type: 'join', token, resume: resumedFromServiceRestart };
  },

  onMessage: (msg) => handle(msg),
  onReconnecting: () => showStatus('reconnecting…'),
  isActive: () => alive, // return false on teardown to stop everything

  // Deploy semantics: RFC 6455 1012 = fast reconnect; 4001 = terminal.
  serviceRestartCode: 1012,
  terminalCloseCodes: [4001],
});

transport.connect();
transport.send({ type: 'chat', text: 'hi' });

// On teardown:
alive = false;
transport.close();
```

### Server side

Nothing to install — this is just a close-code convention. On graceful
shutdown, close each socket with your `serviceRestartCode` so clients take the
fast path:

```ts
for (const ws of sockets) ws.close(1012, 'server-restart');
```

Pair it with a healthcheck that only reports ready once the new instance can
accept connections, so the fast reconnect lands on a live server.

## API

`createResilientWebSocket<TSend, TRecv>(options)` → `{ connect, send, close, socket }`.

| Option | Default | Meaning |
| --- | --- | --- |
| `url` | — | Endpoint to connect to. |
| `onMessage(msg)` | — | Called with every parsed inbound message. |
| `buildOpenMessage(ctx)` | — | Build the first message on open. `ctx.resumedFromServiceRestart` is `true` only on the fast reconnect after a service restart. Return `null`/throw to send nothing. |
| `onReconnecting()` | — | Called right before a reconnect is scheduled. |
| `isActive()` | `() => true` | Gate checked before delivering messages and before reconnecting. |
| `reconnectDelay` | `500` | Base backoff (ms) for the first normal reconnect. |
| `maxReconnectDelay` | `15000` | Backoff cap (ms). |
| `serviceRestartCode` | `null` | Close code that means "come straight back". `null` disables the fast path. |
| `serviceRestartDelay` | `250` | Fast-path delay (ms). |
| `terminalCloseCodes` | `[]` | Close codes on which to stop reconnecting. |
| `jitterRatio` | `0.3` | ±fraction of jitter on every wait. |
| `serialize` / `deserialize` | `JSON.stringify` / `JSON.parse` | Wire codec. |
| `WebSocket` | `globalThis.WebSocket` | Implementation to use (e.g. `ws` in Node). |
| `timers` | global set/clearTimeout | Injectable for tests. |
| `random` | `Math.random` | Injectable RNG for deterministic tests. |

Backoff for attempt _n_ (1-indexed) is
`min(reconnectDelay · 2^(n−1), maxReconnectDelay)`, then jittered — except the
first reconnect after `serviceRestartCode`, which uses `serviceRestartDelay`.

## Test

```sh
pnpm test
```

The tests use a fake WebSocket plus injected timers and RNG, so they are fully
deterministic (no real sockets, no wall-clock waits).

## Origin

Extracted from [InSession](https://insession.space)'s realtime sync layer
(`@in-session/sync`), where it keeps synchronized watch-party sessions alive
across deploys. See the "OSS candidate" write-up for how it was generalized
(protocol types → generics, `1012`/`4001` → configurable close codes).

## License

MIT
