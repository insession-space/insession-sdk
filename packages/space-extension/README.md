# @insession/space-extension

Assemble a headless realtime space out of extensions, the way a headless editor is assembled out of plugins.

You bring your own WebSocket server and your own storage. This package owns the part that is otherwise rewritten in every server: which extension owns which slice of room state, how an incoming action reaches the right reducer, when a timer needs re-arming, and what goes to storage and comes back.

Nothing here performs I/O. `applyAction` returns the next state plus **effect descriptors** — you run them.

- **Zero dependencies.**
- **Open registry.** There is no global list of valid extension names. The extensions you pass in *are* the list, so someone else can write one without editing yours.
- **Namespaced state.** Every slice lives at `roomState[extension.name]`, so two extensions can never collide.

## Install

```bash
npm install @insession/space-extension
```

## Usage

An extension is a name plus whichever halves it participates in: a server-authoritative reducer, a client-side fold, or both.

```ts
import { defineSpaceExtension } from '@insession/space-extension';

const Counter = defineSpaceExtension({
  name: 'counter',
  server: {
    defaultState: () => ({ count: 0 }),
    reduce(state, action) {
      const s = state ?? { count: 0 };
      if (action !== 'inc') return null; // unknown action: nothing happens
      return { count: s.count + 1 };
    },
  },
});
```

Register them, then drive the registry from your own server:

```ts
import { createExtensionRegistry } from '@insession/space-extension';

const registry = createExtensionRegistry([Counter, Board]);

let room = registry.initState();
// => { counter: { count: 0 }, board: { notes: [] } }

const result = registry.applyAction(room, 'counter', 'inc');
if (result) {
  room = result.state;
  for (const effect of result.effects) run(effect);
}
```

`result.effects` is the whole integration surface. One `switch` covers every extension:

```ts
function run(effect) {
  switch (effect.type) {
    case 'broadcast':
      // your WebSocket fan-out
      sendToRoom(effect.message, { excludeSender: effect.excludeSender });
      break;
    case 'send-to-sender':
      sendToActor(effect.message);
      break;
    case 'schedule-timer':
      // replaces any timer already armed for this extension
      arm(effect.extension, effect.delayMs, () => {
        const fired = registry.applyTimer(room, effect.extension);
        if (fired) {
          room = fired.state;
          for (const e of fired.effects) run(e);
        }
      });
      break;
    case 'clear-timer':
      cancel(effect.extension);
      break;
    case 'extension':
      // domain-specific, tagged with its origin
      handleDomainEffect(effect.extension, effect.effect);
      break;
  }
}
```

`broadcast` and `send-to-sender` are core, so they are handled once and work for every extension. Anything else an extension emits arrives as `{ type: 'extension', extension, effect }` — extensions never have to agree on a shared vocabulary, and two of them can both emit a `persist` effect without colliding.

### Persistence

The registry does not touch storage; it shapes what you write and reads back what you stored.

```ts
await db.save(spaceId, registry.persist(room)); // session-only fields stripped
const room = registry.restore(await db.load(spaceId)); // normalized, defaults filled in
```

`restore` leaves slices belonging to extensions this host does not run untouched, so removing an extension from the list does not destroy its stored state on the next write.

### Client side

An extension's client facet folds an incoming update into the local view. `clientExtensions()` returns them in the shape [`@insession/space-state`](https://www.npmjs.com/package/@insession/space-state) expects:

```ts
const store = createSpaceStore({ ...opts, plugins: registry.clientExtensions() });
```

## API

### `defineSpaceExtension(ext)`

Identity function for inference. Throws if `name` is missing or empty.

| Field | Type | Notes |
| --- | --- | --- |
| `name` | `string` | Unique within a registry. Also the state key and broadcast identifier. |
| `options` | `unknown` | Carried for the host. The registry never reads it. |
| `server` | `ExtensionServerFacet` | Server-authoritative reducer. Optional. |
| `client` | `ExtensionClientFacet` | Client-side fold. Optional. |

### `ExtensionServerFacet`

| Member | Type | Required | Notes |
| --- | --- | --- | --- |
| `defaultState` | `() => S` | ✅ | Fresh slice; also the fallback when a restore yields nothing. |
| `reduce` | `(state, action: string, payload?) => S \| { state: S; effects: E[] } \| null` | ✅ | `null` means invalid or no-op: no state change, no effects, no broadcast. Either return shape is accepted. |
| `timerDelay` | `(state: S) => number \| null` | — | Milliseconds until this slice's next event. |
| `onTimer` | `(state: S) => S \| { state; effects } \| null` | — | Called when that timer fires. |
| `restore` | `(raw: unknown) => S \| null` | — | Normalizes a slice from storage. Without it, the slice is treated as session-only. |
| `persistState` | `(state: S) => S` | — | Strips session-only fields before writing. |

`action` is a `string` rather than a union on purpose: it arrives across a wire boundary where the name is untrusted, so anything unrecognized should fall through to `null`.

### `ExtensionClientFacet`

| Member | Type | Notes |
| --- | --- | --- |
| `initLocal` | `(appState) => TLocal` | Record what you joined at. Record only — deciding here re-decides on every reconnect. |
| `onAppState` | `({ local, msg, ctx }) => { local?, lines?, effects? }` | Fold one update into the local view. |

### `createExtensionRegistry(extensions, options?)`

Throws on a duplicate or empty name.

| Option | Default | Notes |
| --- | --- | --- |
| `buildStateMessage` | `({ extension, state }) => ({ type: 'app-state', appId: extension, state })` | The message that goes on your wire is your protocol, so you can name it. |
| `broadcastOnAction` | `true` | Set `false` if you route your own updates. |
| `excludeSenderOnBroadcast` | `false` | Sets `excludeSender` on the automatic broadcast. |

| Method | Returns | Notes |
| --- | --- | --- |
| `names` | `string[]` | Registration order. |
| `has(name)` / `get(name)` | `boolean` / `SpaceExtension \| undefined` | |
| `initState()` | `RoomState` | One namespaced slice per server-participating extension. |
| `applyAction(state, name, action, payload?)` | `{ state, effects } \| null` | `null` for an unknown extension, one with no server facet, or a rejected action — all ordinary on a wire boundary, none an error. |
| `timerDelay(state, name)` | `number \| null` | What is pending, without applying anything. |
| `applyTimer(state, name)` | `{ state, effects } \| null` | Broadcasts on the same terms an action does. |
| `persist(state)` | `RoomState` | |
| `restore(raw)` | `RoomState` | Unusable input yields defaults rather than throwing. |
| `clientExtensions()` | `Array<{ id } & ExtensionClientFacet>` | |

### `SpaceEffect`

| Effect | Meaning |
| --- | --- |
| `{ type: 'broadcast', message, excludeSender? }` | Send to the room. |
| `{ type: 'send-to-sender', message }` | Send only to whoever triggered the action. |
| `{ type: 'schedule-timer', extension, delayMs }` | Arm a timer, replacing any already armed for that extension. |
| `{ type: 'clear-timer', extension }` | Cancel it. |
| `{ type: 'extension', extension, effect }` | A domain-specific effect, tagged with its origin. |

Every accepted transition ends with exactly one of `schedule-timer` / `clear-timer` for the acting extension, re-derived from the new state. Applying them unconditionally is what keeps an armed timer honest across pause, restart, and stop.

## Test

```bash
npm test
```

## License

MIT
