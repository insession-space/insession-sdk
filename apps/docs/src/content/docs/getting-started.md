---
title: Getting started
description: What the @insession packages are, how they fit together, and which one to reach for first.
---

The `@insession` SDK is a set of small packages pulled out of a production
realtime app. They are independent enough that you can adopt one and ignore the
rest.

| Package | What it does | Runtime dependencies |
| --- | --- | --- |
| [`@insession/space`](/packages/space/) | The parent package. Builds a headless space out of extensions: the contract (`defineSpaceExtension`), the aggregate registry, member/presence lifecycle, and an instance (`createSpace`) that turns accepted actions into effect descriptors. Performs no I/O itself. | none |
| [`@insession/ws-resilient-transport`](/packages/ws-resilient-transport/) | Keeps a WebSocket connected across deploys: fast reconnect on service restart, jittered backoff otherwise, terminal close codes that stop retrying. | none |
| [`@insession/space-state`](/packages/space-state/) | Holds the state of a shared room — members, chat, presence, typing, plugins — as a pure reducer over inbound messages. | none |
| [`@insession/extension-chat`](/packages/extension-chat/) | A server-authoritative chat state machine: message normalization, sticker allowlisting, replies, reactions, pins. `reduce` returns `{ state, effects }` — persistence, broadcast, and bot notification are effect descriptors. | none |
| [`@insession/extension-pomodoro`](/packages/extension-pomodoro/) | A server-authoritative Pomodoro timer state machine: pure `reduce`, plus `restore`/`persistState` for the storage boundary. | none |
| [`@insession/extension-whiteboard`](/packages/extension-whiteboard/) | A server-authoritative Whiteboard state machine: shared free-draw strokes/shapes plus an optional "drawing telephone" relay game. | none |
| [`@insession/extension-watch-party`](/packages/extension-watch-party/) | A server-authoritative Watch Party state machine: synchronized video/audio playback with a queue and history. `reduce` returns `{ state, effects }` — no I/O of its own. | none |

## How they fit together

There are no import edges between any of them. `space` does not depend on the
state machines it assembles, the transport does not depend on the store, and
the store does not depend on the transport — you wire all of it yourself:

```
  your server                                your client
     │                                           │
     ├── @insession/space                        ├── @insession/space-state
     │      extensions: [Chat, Pomodoro, …]       │      createSpaceStore({
     │      space.dispatch(appId, action)         │        plugins: space.clientExtensions(),
     │        → SpaceEffect[] (you execute)       │      })
     │              │                             │              │
     │              │                             │    store.onSend(msg) ──┐
     │              │                             │    store.receive(msg) <┘
     │              │                             │              │
     └── @insession/ws-resilient-transport ───────┴──────────────┘
                (you wire the socket between server and client)
```

`space` never opens a socket or touches storage: `space.dispatch(...)` folds an
action through the matching extension's `reduce` and hands back `SpaceEffect[]`
— `broadcast`, `send-to-sender`, `schedule-timer`, or a domain-specific effect —
for you to execute. `space.clientExtensions()` hands the same extensions'
client-side fold to `space-state`'s `plugins` option, so the server's extension
list and the client's plugin list describe the same features without either
package importing the other. Below `space`, the transport still knows nothing
about rooms: the store hands outbound messages to whatever you registered with
`onSend`, and you feed inbound messages back in with `receive`. Wiring any two
of these together is a handful of lines, and in exchange every piece stays
testable with no server and no browser at all.

### "Plugin" vs "extension": the same slice, two names

`@insession/space-state` calls the client-side descriptor a **plugin**
(`definePluginClient`) — that option predates `@insession/space` and the name
stuck. `@insession/space` calls the server-side descriptor an **extension**
(`defineSpaceExtension`) — it's what gets registered and dispatched to. They
are two halves of the same feature: `extension-chat`'s server half is a
`defineSpaceExtension`, and its client half (the fold that reacts to
`app-state`) is shaped like a `definePluginClient` and reaches `space-state`
via `space.clientExtensions()`. Renaming either would be a breaking API
change, so the mismatch stays — read "plugin" as "the client half" and
"extension" as "the server half" wherever the two show up together.

## Which one do I want?

- **You want to assemble a whole space instead of wiring each state machine by
  hand.** Take `@insession/space` as the center: pass your extensions to
  `createSpace`, dispatch actions into it, and execute the `SpaceEffect[]` it
  hands back. Feed `space.clientExtensions()` into `space-state`'s `plugins`
  option and the client side falls out for free.
- **You have a WebSocket that drops on every deploy.** Take
  `ws-resilient-transport` alone. It knows nothing about rooms or state.
- **You are modelling a shared room and want the state logic testable.** Take
  `space-state` alone, and keep your existing transport.
- **Both, in a React app.** Take `ws-resilient-transport` and `space-state`.
  There is no React package: `getState` / `subscribe` are already shaped for
  `useSyncExternalStore`, so the binding is one line you keep in your own code.
- **You need chat: messages, stickers, replies, reactions, pins.** Take
  `extension-chat` alone. `reduce` returns `{ state, effects }` — persistence,
  broadcast, and bot notification are effect descriptors, not I/O the package
  performs itself.
- **You need a shared timer people can start, pause and skip together.** Take
  `extension-pomodoro` alone. It is a state machine only — bring your own transport
  and storage.
- **You need a shared drawing canvas, optionally with a "drawing telephone"
  relay game.** Take `extension-whiteboard` alone. Same shape as
  `extension-pomodoro` — a state machine only.
- **You need synchronized video/audio playback with a queue.** Take
  `extension-watch-party` alone. Like `extension-chat`, it has genuine side
  effects (broadcast, persist, resolve a title) — `reduce` returns them as
  effect descriptors instead of performing them, so it stays a pure function
  you can test without a transport. `extension-pomodoro` and
  `extension-whiteboard` don't need this: their side effects are just a timer
  you drive yourself.

## Install

```sh
npm install @insession/space
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

- [`space`](/packages/space/) — `defineSpaceExtension`, `createSpace`, and the full effect list
- [`ws-resilient-transport`](/packages/ws-resilient-transport/) — every reconnect option, and what to do on the server
- [`space-state`](/packages/space-state/) — the full store API, the effect list, and the plugin contract
- [`extension-chat`](/packages/extension-chat/) — the chat action list and sticker allowlisting
- [`extension-pomodoro`](/packages/extension-pomodoro/) — the timer action list and persistence helpers
- [`extension-whiteboard`](/packages/extension-whiteboard/) — the drawing action list and the relay game
- [`extension-watch-party`](/packages/extension-watch-party/) — the playback action list and effect shapes
- [React binding](/examples/react-binding/) — the one-line hook, and why there is no `getServerSnapshot`
