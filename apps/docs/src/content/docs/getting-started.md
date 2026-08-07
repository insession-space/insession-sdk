---
title: Getting started
description: What the @insession packages are, how they fit together, and which one to reach for first.
---

The `@insession` SDK is a set of small packages pulled out of a production
realtime app. There are no import edges between any of them, so you can adopt
one and ignore the rest.

## The shortest path

Every extension ships a ready-made descriptor. Pass it to `createSpace` and you
have a working server-side feature — no reducer wiring of your own:

```ts
import { createSpace } from '@insession/space';
import { chatExtension } from '@insession/extension-chat';
import { pomodoroExtension } from '@insession/extension-pomodoro';

const space = createSpace({ extensions: [chatExtension(), pomodoroExtension()] });

const effects = space.dispatch('pomodoro', 'start');
// -> [{ type: 'broadcast', ... }, { type: 'schedule-timer', ... }]
```

`space` performs no I/O. `dispatch` folds the action through the matching
extension's `reduce` and hands back `SpaceEffect[]` — `broadcast`,
`send-to-sender`, `schedule-timer`, or a domain-specific effect — for you to
execute against your own socket, storage and timers.

On the client, `space.clientExtensions()` hands the same extensions' client-side
fold to `space-state`'s `plugins` option, so the server's extension list and the
client's plugin list describe the same features without either package importing
the other.

> `space-state` calls the client-side descriptor a **plugin**
> (`definePluginClient`); `space` calls the server-side one an **extension**
> (`defineSpaceExtension`). Read "plugin" as "the client half" and "extension"
> as "the server half" — they are two halves of the same feature.

## The packages

| Package | What it does | Reach for it when |
| --- | --- | --- |
| [`@insession/space`](/packages/space/) | The parent package. Builds a headless space out of extensions: the contract (`defineSpaceExtension`), the aggregate registry, member/presence lifecycle, and an instance (`createSpace`) that turns accepted actions into effect descriptors. | You want to assemble a whole space instead of wiring each state machine by hand. |
| [`@insession/ws-resilient-transport`](/packages/ws-resilient-transport/) | Keeps a WebSocket connected across deploys: fast reconnect on service restart, jittered backoff otherwise, terminal close codes that stop retrying. | You have a WebSocket that drops on every deploy. It knows nothing about rooms or state. |
| [`@insession/space-state`](/packages/space-state/) | Holds the state of a shared room — members, chat, presence, typing, plugins — as a pure reducer over inbound messages. | You are modelling a shared room on the client and want the state logic testable. Keep your existing transport. |
| [`@insession/extension-chat`](/packages/extension-chat/) | Message normalization, sticker allowlisting, replies, reactions, pins. | You need chat. Persistence, broadcast and bot notification come back as effect descriptors, not I/O the package performs. |
| [`@insession/extension-pomodoro`](/packages/extension-pomodoro/) | A shared timer with declarations and cheers, plus `restore`/`persistState` for the storage boundary. | You need a timer people start, pause and skip together. Bring your own transport and storage. |
| [`@insession/extension-whiteboard`](/packages/extension-whiteboard/) | Shared free-draw strokes/shapes plus an optional "drawing telephone" relay game. | You need a shared drawing canvas. Same shape as `extension-pomodoro`. |
| [`@insession/extension-watch-party`](/packages/extension-watch-party/) | Synchronized video/audio playback with a queue and history. | You need synchronized playback. Like chat, it has genuine side effects (broadcast, persist, resolve a title) — returned as descriptors so `reduce` stays pure. |

All seven have **zero runtime dependencies**. The four `extension-*` packages
are server-authoritative state machines whose `reduce` returns
`{ state, effects } | null`.

## Install

```sh
npm install @insession/space
```

Every package ships built, with TypeScript types included. `space` and the four
`extension-*` packages ship both ESM (`dist/index.js`) and CommonJS
(`dist/index.cjs`), so a server that `require()`s them works too. `space-state`
and `ws-resilient-transport` are ESM-only. Node 22.18+ or any modern bundler.

## Bringing your own transport

`space` never opens a socket. Below it, the transport still knows nothing about
rooms: the store hands outbound messages to whatever you registered with
`onSend`, and you feed inbound messages back in with `receive`.

```
  your server                                your client
     │                                           │
     ├── @insession/space                        ├── @insession/space-state
     │      extensions: [Chat, Pomodoro, …]      │      createSpaceStore({
     │      space.dispatch(appId, action)        │        plugins: space.clientExtensions(),
     │        → SpaceEffect[] (you execute)      │      })
     │              │                            │              │
     │              │                            │    store.onSend(msg) ──┐
     │              │                            │    store.receive(msg) <┘
     │              │                            │              │
     └── @insession/ws-resilient-transport ──────┴──────────────┘
                (you wire the socket between server and client)
```

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

Using React? There is no binding package to install: `getState` / `subscribe`
already satisfy `useSyncExternalStore`, so [one line of your
own](/examples/react-binding/) is the whole hook.
