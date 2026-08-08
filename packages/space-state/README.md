# @insession/space-state

A **dependency-free state store for realtime shared rooms** — members, chat,
presence, typing indicators, pinned messages and pluggable per-room apps.

Most realtime state layers fuse three things that want to be separate: the
reducer that folds inbound messages, the socket that carries them, and the
side effects that fire when something happens (a sound, a notification, a
timer). Fuse them and you can no longer test the interesting part — the state
transitions — without standing up a server and a browser.

This store keeps them apart:

- **Inbound messages fold through a pure reducer.** `receive(msg)` runs
  `reduceSpace`, which is a plain function of `(state, msg, ctx)`. No I/O.
- **Outbound messages are handed off, not sent.** Local actions such as
  `chat.send()` produce a message and pass it to whatever you registered with
  `onSend`. The store never opens a socket.
- **Side effects are returned as descriptors, never executed.** "Play the chat
  sound", "show a notification", "clear this typing indicator in 3s" arrive at
  your `onEffect` handler as data. What that means in your app is your call.
- **Zero runtime dependencies.** No React, no WebSocket, no DOM. Tests run
  under `node --test` with no server, no browser and no sockets.

## Install

```sh
npm install @insession/space-state
```

Published as a built ESM package (`dist/index.js` + `dist/index.d.ts`), no
runtime dependencies. There is nothing else to install — see
[Binding it to React](#binding-it-to-react) if that is your UI layer.

## Usage

```ts
import { createSpaceStore } from '@insession/space-state';

const store = createSpaceStore({
  selfName: 'alice',
  t: (key) => key,            // any string resolver; pass your i18n `t`, or identity in tests
  getPresence: () => 'active',
});

// Outbound: wire local actions to your transport. Actually sending is your job.
store.onSend((msg) => ws.send(JSON.stringify(msg)));

// Effects: the store describes them, you execute them.
store.onEffect((effect) => {
  if (effect.type === 'sound' && effect.sound === 'chat') playChatSound();
  if (effect.type === 'notify-chat') notify(`${effect.name}: ${effect.text}`);
});

// Inbound: feed raw server messages in. The reducer folds them and notifies subscribers.
ws.onmessage = (ev) => store.receive(JSON.parse(ev.data));

// Read state / subscribe to changes (useSyncExternalStore contract:
// getState() returns the same reference while nothing has changed).
store.getState().members;
const unsubscribe = store.subscribe(() => render());

// Local actions: send to the server, and optimistically reflect locally where it matters.
store.chat.send('hello');
store.chat.react(messageId, '🎉');
store.presence.change('away');
store.settings.update({ theme: 'dark' });
```

### Binding it to React

`getState` / `subscribe` are shaped for `useSyncExternalStore`, so there is no
React package to install — the binding is one line you keep with your own hooks:

```tsx
import type { SpaceState, SpaceStore } from '@insession/space-state';
import { useSyncExternalStore } from 'react';

export function useSpaceState(store: SpaceStore): SpaceState {
  return useSyncExternalStore(store.subscribe, store.getState);
}
```

Re-rendering already behaves: `getState()` returns the same reference while
nothing has changed, so React bails out on messages that do not alter state
(a repeated `typing` from the same person, for instance).

Pass a third argument if you server-render. This package deliberately ships no
default for it — the store's state presupposes a live connection, so what a
server should show instead is your product's decision, not ours.

### Testing without a server

Because `receive` takes a plain object and effects are only descriptors, a full
state transition is assertable in-process:

```ts
const store = createSpaceStore({ selfName: 'alice', t: (k) => k, getPresence: () => 'active' });
const effects = [];
store.onEffect((e) => effects.push(e));

store.receive({ type: 'chat', name: 'bob', text: 'hi' });

store.getState().chatLines.at(-1).text;
// 'hi'
effects;
// [{ type: 'typing-timer-clear', name: 'bob' },
//  { type: 'sound', sound: 'chat' },
//  { type: 'notify-chat', name: 'bob', text: 'hi' }]
```

## API

### `createSpaceStore(options): SpaceStore`

| Option | Default | Meaning |
| --- | --- | --- |
| `selfName` | — | The local user's display name. Used to mark messages as your own. Replaceable later via `setSelfName`. |
| `t` | — | String resolver `(key, ...args) => string` for system chat lines. Pass your i18n `t`, or the identity function. Replaceable later via `setT`. |
| `getPresence` | — | `() => 'active' \| 'away'`. Read whenever the reducer needs your current presence. |
| `now` | `Date.now` | Clock. Inject to make tests deterministic. |
| `genClientMsgId` | `crypto.randomUUID` with fallback | Generates the temporary id that ties a locally echoed chat line to the server's eventual id. |
| `plugins` | `[]` | Per-room app clients (see [Plugins](#plugins)). The core knows nothing app-specific on its own. |
| `initialSettings` | `{}` | Default value for `state.settings`. The store never reads inside `settings` — the shape belongs to your wire contract, so you inject the defaults. |

### Store methods

| Member | Meaning |
| --- | --- |
| `receive(msg)` | Fold a raw inbound message. Updates state and dispatches effects. |
| `getState()` / `subscribe(fn)` | `useSyncExternalStore`-compatible pair. `getState()` returns the same reference while state is unchanged. `subscribe` returns an unsubscribe function. |
| `onSend(fn)` / `send(msg)` | Register a transport / push a raw outbound message. Returns an unsubscribe function. |
| `onEffect(fn)` | Register an effect executor. Returns an unsubscribe function. |
| `chat.send(text, replyTo?)` | Send a chat message and echo it locally right away (no round-trip wait). |
| `chat.sendSticker(imageUrl)` | Send an image message; `imageUrl` is a URL you uploaded beforehand. |
| `chat.react(messageId, emoji)` | Toggle an emoji reaction, optimistically applied locally. No-op when `messageId` is `null` (the message has no server id yet). |
| `chat.pin(messageId)` | Pin a message, or unpin with `null`. The server stays authoritative. |
| `chat.typing()` | Announce typing. Safe to call on every keystroke — calls within 1s are throttled away. |
| `settings.update(patch)` | Send a settings patch. The store does not interpret its contents. |
| `presence.change(p)` | Send `'active'` / `'away'`. |
| `stage.change(stage)` | Send which card the local user is currently showing (`null` for none). |
| `addChatLine(line)` | Append a local system line. |
| `clearTyping(name)` / `expireAgentStatus(id, requestId)` | Called by you when the corresponding `typing-timer` / `agent-timer` effect fires. |
| `reset()` | Reset connection-scoped state on disconnect. |
| `setT(fn)` / `setSelfName(name)` | Swap the resolver / display name without reconnecting. |

### Effects

`onEffect` receives a `SpaceEffect` — a discriminated union on `type`:

| `type` | Payload | What it asks you to do |
| --- | --- | --- |
| `sound` | `sound: 'join' \| 'chat'` | Play a sound. |
| `notify-join` / `notify-chat` | `name`, and `text` for chat | Show a notification. Wording and mention detection are yours. |
| `plugin-sound` / `plugin-notify` | `appId`, `sound` / `text` | Same, but originating from a plugin. Mapping `appId` to an actual sound is yours. |
| `history-title` | `title` | Update your local visit history. |
| `send` | `message` | Send this message (reducer-initiated, e.g. re-announcing presence). |
| `typing-timer` / `typing-timer-clear` | `name` | Start a 3s timer that calls `clearTyping(name)` / cancel it. |
| `agent-timer` / `agent-timer-clear` | `agentId`, `requestId` | Start a safety timer that calls `expireAgentStatus(...)` / cancel it. |

### Plugins

A room can host apps. The core carries no app-specific logic; each app supplies
a `PluginClient` and the reducer calls it only for its own `appId`:

```ts
import { definePluginClient } from '@insession/space-state';

const timer = definePluginClient({
  id: 'timer',
  // Seed this plugin's local slice (state.pluginLocal['timer']) on join/reconnect.
  // Record previous values here only — deciding and emitting effects on join
  // makes them fire every time someone enters the room.
  initLocal: (appState) => ({ phase: appState?.phase ?? null }),
  // Called on each app-state message for this id. The core has already stored
  // the latest value in state.apps[id]; return only your local slice, chat
  // lines to append, and effects to emit.
  //
  // Your extension's own state is under `msg.state` — `msg` itself is the
  // envelope (`type`, `appId`, `state`, and optionally `action`/`by`).
  onAppState: ({ local, msg }) =>
    local.phase === msg.state.phase
      ? {}
      : {
          local: { phase: msg.state.phase },
          effects: [{ type: 'plugin-sound', appId: 'timer', sound: 'ding' }],
        },
});

createSpaceStore({ /* … */ plugins: [timer] });
```

### A note on `settings`

`state.settings` is deliberately opaque (`Record<string, unknown>`). The store holds
and replaces it wholesale and never looks inside, so the settings type — and its
defaults, via `initialSettings` — stay part of *your* wire contract rather than
this package's. This is the same reasoning that keeps the store free of a server
and of persistence.

## Test

```sh
node --test
```

The reducer tests assert state transitions directly. No server, no browser, no
sockets, no wall-clock waits.

## Origin

Extracted from [InSession](https://insession.space)'s realtime rooms, where it
backs synchronized watch parties, shared timers and in-room chat. Generalizing
it meant removing the product's wire-contract types (settings became opaque),
moving side effects out of the reducer into descriptors, and pushing all
app-specific behaviour behind the plugin contract.

## License

MIT
