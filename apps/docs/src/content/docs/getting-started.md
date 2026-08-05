---
title: Getting started
description: What the five @insession packages are, how they fit together, and which one to reach for first.
---

The `@insession` SDK is five small packages pulled out of a production realtime
app. They are independent enough that you can adopt one and ignore the rest.

| Package | What it does | Runtime dependencies |
| --- | --- | --- |
| [`@insession/ws-resilient-transport`](/packages/ws-resilient-transport/) | Keeps a WebSocket connected across deploys: fast reconnect on service restart, jittered backoff otherwise, terminal close codes that stop retrying. | none |
| [`@insession/space-state`](/packages/space-state/) | Holds the state of a shared room — members, chat, presence, typing, plugins — as a pure reducer over inbound messages. | none |
| [`@insession/space-state-react`](/packages/space-state-react/) | Binds the store to React via `useSyncExternalStore`. One hook. | `@insession/space-state` (+ `react` as a peer) |
| [`@insession/plugin-pomodoro-state`](/packages/plugin-pomodoro-state/) | A server-authoritative Pomodoro timer state machine: pure `reduce`, plus `restore`/`persistState` for the storage boundary. | none |
| [`@insession/plugin-whiteboard-state`](/packages/plugin-whiteboard-state/) | A server-authoritative Whiteboard state machine: shared free-draw strokes/shapes plus an optional "drawing telephone" relay game. | none |

## How they fit together

The only edge between them is `space-state-react` → `space-state`. The transport
does **not** depend on the store, and the store does **not** depend on the
transport:

```
  your app
     │
     ├── @insession/space-state-react ──> @insession/space-state
     │                                          │
     │                            store.onSend(msg) ──┐
     │                            store.receive(msg) <┘
     │                                          │
     └── @insession/ws-resilient-transport ─────┘
                (you wire these two together)
```

That gap is deliberate. The store never opens a socket: it hands outbound
messages to whatever you registered with `onSend`, and you feed inbound messages
back in with `receive`. Wiring them together is three lines, and in exchange the
store stays testable with no server and no browser at all.

## Which one do I want?

- **You have a WebSocket that drops on every deploy.** Take
  `ws-resilient-transport` alone. It knows nothing about rooms or state.
- **You are modelling a shared room and want the state logic testable.** Take
  `space-state` alone, and keep your existing transport.
- **Both, in a React app.** Take `ws-resilient-transport`, `space-state`, and
  `space-state-react`.
- **You need a shared timer people can start, pause and skip together.** Take
  `plugin-pomodoro-state` alone. It is a state machine only — bring your own transport
  and storage.
- **You need a shared drawing canvas, optionally with a "drawing telephone"
  relay game.** Take `plugin-whiteboard-state` alone. Same shape as
  `plugin-pomodoro-state` — a state machine only.

## Install

```sh
npm install @insession/space-state @insession/space-state-react @insession/ws-resilient-transport
```

Every package ships as built ESM (`dist/index.js` + `dist/index.d.ts`) with
TypeScript types included. Node 22.18+ or any modern bundler.

## Wiring the two together

```ts
import { createSpaceStore } from '@insession/space-state';
import { createResilientWebSocket } from '@insession/ws-resilient-transport';

const store = createSpaceStore({
  selfName: 'alice',
  t: (key) => key,
  getPresence: () => 'active',
});

const transport = createResilientWebSocket({
  url: 'wss://example.com/ws',
  buildOpenMessage: async ({ resumedFromServiceRestart }) => ({
    type: 'join',
    resume: resumedFromServiceRestart,
  }),
  onMessage: (msg) => store.receive(msg), // inbound: socket → store
  serviceRestartCode: 1012,
});

store.onSend((msg) => transport.send(msg)); // outbound: store → socket
transport.connect();
```

Side effects the store asks for (a sound, a notification, a timer) arrive
separately through `store.onEffect` — the store describes them, your app decides
what they mean.

## Next

- [`ws-resilient-transport`](/packages/ws-resilient-transport/) — every reconnect option, and what to do on the server
- [`space-state`](/packages/space-state/) — the full store API, the effect list, and the plugin contract
- [`space-state-react`](/packages/space-state-react/) — the hook, and why there is no `getServerSnapshot`
