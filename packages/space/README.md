# @insession/space

Build a headless realtime space out of extensions, the way a headless editor is built out of plugins.

You bring your own WebSocket server and your own storage. This package owns what sits between them: **who is connected**, **which extension owns which slice of its state**, **how an action reaches the right reducer**, **when a timer needs re-arming**, and **what goes to storage and comes back**.

Nothing here performs I/O. Every transition returns **effect descriptors** — you run them. That is what lets the same space run on a `ws` server, a Durable Object, or a test with no network at all.

- **Zero dependencies.**
- **Open registry.** There is no global list of valid extension names. The extensions you pass in *are* the list, so someone else can write one without editing yours.
- **Namespaced state.** Every slice lives under its extension's name, so two extensions can never collide.
- **Multi-device aware.** The same account on a laptop and a phone is two connections and one arrival.

## Install

```bash
npm install @insession/space
```

## Usage

An extension is a name plus whichever halves it participates in: a server-authoritative reducer, a client-side fold, or both.

```ts
import { defineSpaceExtension } from '@insession/space';

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

Create the space, then drive it from your own server:

```ts
import { createSpace } from '@insession/space';

const space = createSpace({ extensions: [Counter, Chat] });

wss.on('connection', (ws) => {
  const connId = nextId();
  run(space.join({ connId, name, uid }), ws);

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    // `by` comes from authenticated context, not from the client's frame.
    run(space.dispatch(msg.appId, msg.action, { ...msg.payload, by: name }), ws);
  });

  ws.on('close', () => {
    run(space.leave(connId), ws);
    if (space.isEmpty()) await db.save(spaceId, space.snapshot());
  });
});
```

`effects` is the whole integration surface. One `switch` covers every extension:

```ts
function run(effects, ws) {
  for (const effect of effects) {
    switch (effect.type) {
      case 'broadcast':
        sendToEveryone(effect.message, { exclude: effect.excludeSender ? ws : undefined });
        break;
      case 'send-to-sender':
        ws.send(JSON.stringify(effect.message));
        break;
      case 'schedule-timer':
        // replaces any timer already armed for this extension
        arm(effect.extension, effect.delayMs, () => run(space.fireTimer(effect.extension)));
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
}
```

`broadcast` and `send-to-sender` are core, so they are handled once and work for every extension. Anything else an extension emits arrives as `{ type: 'extension', extension, effect }` — extensions never have to agree on a shared vocabulary, and two of them can both emit a `persist` effect without colliding.

### Who is connected

`members()` is one entry per socket, which is what you deliver to. `people()` collapses them by account, which is what you display.

```ts
space.members(); // [{ connId: 'a', name: 'Ada', uid: 'u1', presence: 'active' }, { connId: 'b', ... }]
space.people();  // one entry — the same person on two devices
```

Arrivals and departures follow the same rule: joining a second device is not a second arrival, and closing one of two tabs is not a departure. A socket that closes twice (close event *and* heartbeat timeout) announces nothing the second time.

### Persistence

The space does not touch storage; it shapes what you write and reads back what you stored.

```ts
await db.save(spaceId, space.snapshot()); // session-only fields stripped
space.hydrate(await db.load(spaceId));    // normalized, defaults filled in
run(space.armTimers());                   // re-arm what the restart dropped
```

`hydrate` leaves slices belonging to extensions this host does not run untouched, so removing an extension from the list does not destroy its stored state on the next write.

### Client side

An extension's client facet folds an incoming update into the local view. `clientExtensions()` returns them in the shape [`@insession/space-state`](https://www.npmjs.com/package/@insession/space-state) expects:

```ts
const store = createSpaceStore({ ...opts, plugins: space.clientExtensions() });
```

### Owning the state yourself

`createSpace` holds the state for you. If your host already has its own state discipline — a database row, a snapshot per revision, an actor framework — the pure layer underneath is exported too: `createExtensionRegistry` plus the functions under `members/` take state in and hand it back.

```ts
const registry = createExtensionRegistry([Counter, Chat]);
const result = registry.applyAction(slices, 'counter', 'inc');
// result: { state, effects } | null
```

## API

### `defineSpaceExtension(ext)`

Identity function for inference. Throws if `name` is missing or empty.

| Field | Type | Notes |
| --- | --- | --- |
| `name` | `string` | Unique within a space. Also the state key and broadcast identifier. |
| `options` | `unknown` | Carried for the host. This package never reads it. |
| `server` | `ExtensionServerFacet` | Server-authoritative reducer. Optional. |
| `client` | `ExtensionClientFacet` | Client-side fold. Optional. |

#### `ExtensionServerFacet`

| Member | Type | Required | Notes |
| --- | --- | --- | --- |
| `defaultState` | `() => S` | ✅ | Fresh slice; also the fallback when a restore yields nothing. |
| `reduce` | `(state, action: string, payload?) => S \| { state: S; effects: E[] } \| { effects: E[] } \| null` | ✅ | `null` means invalid or no-op: nothing at all happens. `{ effects }` alone means "run these, but nothing changed" — see below. |
| `timerDelay` | `(state: S) => number \| null` | — | Milliseconds until this slice's next event. |
| `onTimer` | `(state: S) => S \| { state; effects } \| null` | — | Called when that timer fires. |
| `restore` | `(raw: unknown) => S \| null` | — | Normalizes a slice from storage. Without it, the slice is treated as session-only. |
| `persistState` | `(state: S) => S` | — | Strips session-only fields before writing. |

`action` is a `string` rather than a union on purpose: it arrives across a wire boundary where the name is untrusted, so anything unrecognized should fall through to `null`.

#### `ExtensionClientFacet`

| Member | Type | Notes |
| --- | --- | --- |
| `initLocal` | `(appState) => TLocal` | Record what you joined at. Record only — deciding here re-decides on every reconnect. |
| `onAppState` | `({ local, msg, ctx }) => { local?, lines?, effects? }` | Fold one update into the local view. |

### `createSpace(options)`

| Option | Default | Notes |
| --- | --- | --- |
| `extensions` | — | Required. Throws on a duplicate or empty name. |
| `buildSyncMessage` | `{ type: 'space-state', selfId, members, extensions }` | Sent to a connection that just joined. |
| `buildJoinMessage` | `{ type: 'member-joined', member, members }` | |
| `buildLeaveMessage` | `{ type: 'member-left', member, members }` | |
| `buildPresenceMessage` | `{ type: 'member-updated', member, members }` | |
| `buildStateMessage` | `{ type: 'app-state', appId, state }` | Broadcast after an accepted action. |
| `broadcastOnAction` | `true` | Set `false` if you route your own updates. |
| `excludeSenderOnBroadcast` | `false` | Sets `excludeSender` on the automatic state broadcast. |

Every message builder is injectable because the envelope on the wire is your protocol, not this package's.

| Method | Returns | Notes |
| --- | --- | --- |
| `join({ connId, name, uid?, presence? })` | `SpaceEffect[]` | Always re-syncs the arriving connection; announces only a first connection. |
| `leave(connId)` | `SpaceEffect[]` | Announces only a last connection. Unknown id is a silent no-op. |
| `setPresence(connId, presence)` | `SpaceEffect[]` | Empty when nothing changed. |
| `dispatch(extension, action, payload?)` | `SpaceEffect[]` | Empty for an unknown extension, no server facet, or a rejected action. |
| `fireTimer(extension)` | `SpaceEffect[]` | In response to a `schedule-timer` effect firing. |
| `armTimers()` | `SpaceEffect[]` | Every extension's timer, re-derived from current state. |
| `snapshot()` / `hydrate(raw)` | `ExtensionState` / `void` | Storage in and out. `hydrate` does not touch members. |
| `getState()` / `members()` / `people()` / `isEmpty()` | | |
| `clientExtensions()` | `Array<{ id } & ExtensionClientFacet>` | |

### `SpaceEffect`

| Effect | Meaning |
| --- | --- |
| `{ type: 'broadcast', message, excludeSender? }` | Send to everyone in the space. |
| `{ type: 'send-to-sender', message }` | Send only to whoever triggered the action. |
| `{ type: 'schedule-timer', extension, delayMs }` | Arm a timer, replacing any already armed for that extension. |
| `{ type: 'clear-timer', extension }` | Cancel it. |
| `{ type: 'extension', extension, effect }` | A domain-specific effect, tagged with its origin. |

Every accepted extension transition ends with exactly one of `schedule-timer` / `clear-timer`, re-derived from the new state. Applying them unconditionally is what keeps an armed timer honest across pause, restart, and stop.

### Forwarding without storing

A live relay — a drawing preview streaming a frame per pointer move — is worth
forwarding to the other members and not worth keeping. Return `{ effects }`
with no `state`:

```ts
reduce(state, action, payload) {
  if (action === 'frame') {
    return { effects: [{ type: 'broadcast', message: { type: 'frame', payload }, excludeSender: true }] };
  }
  ...
}
```

Nothing is stored, **no state broadcast goes out, and no timer is re-armed** —
a timer derived from an unchanged slice is the one already running, and
re-arming it every frame would reset a countdown that is supposed to run out.

`applyAction` hands back the **same state object** in this case, so a host can
skip its write with a reference check:

```ts
const result = registry.applyAction(slices, name, action, payload);
if (result) {
  if (result.state !== slices) await db.save(spaceId, registry.persist(result.state));
  slices = result.state;
  for (const effect of result.effects) run(effect);
}
```

⚠ This is not `null`. `null` means the action was invalid or a no-op and
**nothing at all** happens; `{ effects }` means something should happen, just
not to the state.

### Pure layer

`createExtensionRegistry(extensions, options?)` — `names`, `has`, `get`, `initState`, `applyAction`, `timerDelay`, `applyTimer`, `persist`, `restore`, `clientExtensions`.

Member functions over a plain `SpaceMember[]` — `addConnection`, `removeConnection`, `setPresence`, `findMember`, `hasConnection`, `isFirstConnectionOfUid`, `isLastConnectionOfUid`.

`dedupeByUid` is generic over your own member row (`<T extends DedupableMember>`): it reads only `uid` and `presence`, and hands entries back as they went in — apart from `presence`, the one field it may rewrite. Use it on a lobby list that carries avatars and whatever else you render, without pushing that shape through `SpaceMember`.

## Test

```bash
npm test
```

## License

MIT
