# @insession/plugin-watch-party-state

A **dependency-free, server-authoritative Watch Party state machine**: one
shared "now playing" item (a YouTube video or a SoundCloud track), a queue,
and a play history — synchronized across everyone in a room.

Building "everyone watches the same video, in sync" is deceptively fiddly:
broadcasting a position every second wastes bandwidth and still drifts, a
queue add can lose the send order the moment one lookup is slower than the
next, and "the video ended" arrives from *every* client at once and has to be
handled exactly once. This package is that state machine, with none of the
plumbing:

- **`reduce` is a pure function.** `(state, action, payload) => { state,
  effects } | null`. No I/O — `null` means "ignore this action" (invalid
  payload, or a genuine no-op like an empty `seek`).
- **Side effects are descriptors, not callbacks.** Instead of taking a
  `broadcast`/`persist`/`fetchTitle` function and calling it internally,
  `reduce` returns a list of typed `WatchPartyEffect` objects describing what
  should happen. Your host interprets and executes them. This keeps `reduce`
  fully synchronous and trivially testable — see [Effects](#effects) below.
- **No wall-clock ticking.** Position is derived on demand
  (`currentPosition`) by extrapolating from the last known position and
  timestamp while playing. The server only needs to react to actual
  play/pause/seek/load events (plus an occasional `request-sync` for a
  client catching up after being backgrounded).
- **Every input is capped and validated.** Video/track ids, queue length,
  per-member queue limits, title/URL lengths — all bounded, so a malicious or
  buggy client can't grow shared state without limit or smuggle garbage into
  a broadcast.
- **`restore` is defensive by design.** Feed it whatever your storage layer
  handed back — even malformed JSON — and it returns a safe state with caps
  applied. Playback always comes back stopped (not resumed against a clock
  that's no longer valid after a restart).

## What this package deliberately does not do

This is the *synchronization* layer, not a media client. It has **no
dependencies**, including no HTTP client, so it cannot and does not:

- Search for videos/tracks, resolve oEmbed titles, fetch durations, or talk
  to any provider's API. When a title/duration is unknown, `reduce` emits a
  `resolve-metadata` effect asking your host to go find it — see
  [Resolving titles and durations](#resolving-titles-and-durations).
- Persist anything to a database, or send anything over a WebSocket (or any
  other transport). It only describes those actions as effects.
- Validate that a submitted `mediaUrl`/`thumbnail` points somewhere trusted
  (e.g. an allow-listed SoundCloud host). That's provider-specific policy
  this package doesn't own — validate it yourself before the payload reaches
  `reduce`.
- Pick a candidate for you when a shared "auto-DJ" / "mix" feature is active.
  It only guarantees such a feature can take priority over the queue without
  this package interfering — see
  [Deferring to a host-owned "mix" feature](#deferring-to-a-host-owned-mix-feature).

## Install

```sh
npm install @insession/plugin-watch-party-state
```

Published as a built package with both ESM (`dist/index.js`) and CommonJS
(`dist/index.cjs`) entry points plus `dist/index.d.ts` types, no runtime
dependencies.

## Usage

```ts
import {
  createWatchParty,
  type WatchPartyEffect,
  type WatchPartyState,
} from '@insession/plugin-watch-party-state';

const watchParty = createWatchParty({
  // Optional: how to pick a candidate when shuffle is on. Omit it and
  // shuffle is inert (always plays FIFO). See "Shuffle" below.
  pickShuffleIndex: (items, currentVideoId) =>
    Math.floor(Math.random() * items.length),
});

// Somewhere you keep one WatchPartyState per room, e.g. a Map<roomId, WatchPartyState>.
let state: WatchPartyState = watchParty.defaultState();

// A client action arrives over your transport (WebSocket, etc). `by`/`addedBy`
// identify the acting member; it's your call how you derive them (session, auth, ...).
function onClientAction(action: string, payload: unknown) {
  const result = watchParty.reduce(state, action, payload as Record<string, unknown>);
  if (!result) return; // invalid or a no-op — nothing changed, nothing to do
  state = result.state;
  for (const effect of result.effects) runEffect(effect);
}

function runEffect(effect: WatchPartyEffect) {
  switch (effect.type) {
    case 'broadcast':
      broadcastToRoom(effect.message, { excludeSender: effect.excludeSender });
      break;
    case 'send-to-sender':
      sendToSender(effect.message);
      break;
    case 'persist-playback':
      db.savePlaybackState(roomId, effect.videoId, effect.isPlaying, effect.position).catch(() => {});
      break;
    case 'persist-media':
      db.saveMedia(roomId, effect.provider, effect.mediaUrl, effect.thumbnail).catch(() => {});
      break;
    case 'resolve-metadata':
      // Go fetch a title/duration however you like (oEmbed, a provider API,
      // a cache, ...), then feed the result back in — see below.
      resolveTitleAndDuration(effect).then(({ title, durationSec }) => {
        const patched = watchParty.reduce(state, 'resolve-metadata', {
          uid: effect.uid,
          kind: effect.kind,
          title,
          durationSec,
        });
        if (!patched) return;
        state = patched.state;
        for (const e of patched.effects) runEffect(e);
      });
      break;
  }
}

// Load from storage on room startup / first join.
function loadFromDb(raw: unknown) {
  state = watchParty.restore(raw) ?? watchParty.defaultState();
}
```

### Actions

`reduce(state, action, payload)` accepts these `action` strings:

| Action | Payload | Effect |
| --- | --- | --- |
| `load-video` | `{ videoId, provider?, mediaUrl?, thumbnail?, title?, durationSec?, by? }` | Loads and plays an item immediately (position 0). Records a history entry. |
| `play` | `{ position?, by? }` | Resumes playback. An invalid/missing `position` keeps the current (extrapolated) position rather than rewinding to 0. |
| `pause` | — | **Always a no-op.** See [Why `pause` does nothing](#why-pause-does-nothing). |
| `seek` | `{ position, by? }` | Jumps to `position`. An invalid `position` does nothing at all (no broadcast, no persistence) — there's no safe fallback for a garbage seek target. |
| `video-ended` | `{ videoId, shuffleEnabled?, mixActive? }` | Reported by every client; only honored if `videoId` matches the current item. Advances the queue, defers entirely if `mixActive`, or freezes playback if there's nothing next. See [Deferring to a host-owned "mix" feature](#deferring-to-a-host-owned-mix-feature). |
| `request-sync` | — | No state change. Emits a `send-to-sender` effect with the current position, for a client that needs to catch up immediately. |
| `queue-add` | `{ videoId, provider?, mediaUrl?, thumbnail?, title?, durationSec?, addedBy?, addedByUid?, addSeq?, maxQueueLength?, maxPerUser?, maxDurationSec?, shuffleEnabled? }` | Adds to the queue in send order (see `addSeq` below). Auto-plays if nothing is currently playing. |
| `queue-remove` | `{ uid }` | Removes one item by id. No-op if not found. |
| `queue-clear` | — | Empties the queue. No-op if already empty. |
| `queue-reorder` | `{ uid, toIndex, shuffleEnabled? }` | Moves an item. Ignored entirely while `shuffleEnabled` (reordering has no meaning when play order isn't array order). |
| `queue-play` | `{ uid, by?, byUid? }` | Plays a specific queued item immediately, regardless of position. |
| `queue-play-next` | `{ by?, byUid?, shuffleEnabled? }` | Advances the queue (FIFO, or via `pickShuffleIndex` when `shuffleEnabled`). No-op on an empty queue. |
| `resolve-metadata` | `{ uid, kind?, title?, durationSec? }` | Applies a host-resolved title/duration to the queue (`kind: 'queue'`, the default) or history (`kind: 'history'`) item with that `uid`. Never overwrites a field that's already known. No-op if the item is gone (already played/removed/aged out). |

Any other `action` string returns `null`. Because the payload arrives over
the wire, every field is treated as untrusted and validated at the point of
use — `reduce` never throws on malformed input.

A few payload fields are **host-trusted settings**, not wire data: `shuffleEnabled`,
`mixActive`, `maxQueueLength`, `maxPerUser`, and `maxDurationSec`. Your host is
expected to read these from its own room/space settings and fold them into the
payload before calling `reduce` — the same way it's expected to derive `by`/
`addedBy` from an authenticated session rather than trust a client-submitted name.

### Effects

`reduce` never performs I/O. It returns `{ state, effects }`, where `effects`
is a list of `WatchPartyEffect` descriptors:

```ts
type WatchPartyEffect =
  | { type: 'broadcast'; message: unknown; excludeSender?: boolean }
  | { type: 'send-to-sender'; message: unknown }
  | { type: 'persist-playback'; videoId: string | null; isPlaying: boolean; position: number }
  | { type: 'persist-media'; provider: WatchPartyProvider | null; mediaUrl: string | null; thumbnail: string | null }
  | {
      type: 'resolve-metadata';
      uid: string;
      kind: 'queue' | 'history';
      videoId: string;
      provider: WatchPartyProvider;
      mediaUrl: string | null;
      by: string | null;
      byUid: string | null;
      durationSec: number | null;
    };
```

Your host loops over `result.effects` and executes each one against its own
transport/storage — see the `runEffect` example above. This mirrors the
effect-descriptor convention `@insession/space-state`'s `reduceSpace` uses:
the reducer describes *what* should happen, the host decides *how*.

`broadcast`/`send-to-sender` messages are already stripped of internal-only
fields (`addedByUid`, `addSeq` on queue items; `byUid` on history items) —
your host can forward `effect.message` straight to the wire without having to
remember to sanitize it itself.

### Resolving titles and durations

This package never fetches a title or duration itself — it has no HTTP
client and no opinion on your provider's API. When `queue-add` or a
play-transition (`load-video`, `queue-play`, an auto-advance, ...) doesn't
already know an item's title, `reduce` emits a `resolve-metadata` effect
carrying everything you need to look it up (`videoId`, `provider`,
`mediaUrl`) plus a `uid`/`kind` pair identifying exactly which queue or
history entry to patch. Once you've resolved it, call `reduce` again with
action `'resolve-metadata'` and that same `uid`/`kind`:

```ts
watchParty.reduce(state, 'resolve-metadata', {
  uid: effect.uid,
  kind: effect.kind, // 'queue' | 'history'
  title: 'Never Gonna Give You Up',
  durationSec: 213,
});
```

This never overwrites a title/duration that's already known (in case two
resolutions race, or the item finished resolving via another path), and it's
a no-op if the item is gone by the time you resolve it (already played,
removed, or aged out of the capped history) — matching the app this was
ported from, which has the same fail-open shrug for a metadata fetch that
lands after its target disappeared.

### Deferring to a host-owned "mix" feature

Some hosts layer an "auto-DJ"/"mix" feature on top of Watch Party (pick a
random next track from a pool, keep the party going with no manual queueing)
— entirely out of scope for this package, since it usually needs an LLM, a
recommendation API, or a user's library. But when a video ends, that feature
needs to take priority over the plain queue, and it should never have this
package's own queue-advance race against it.

`video-ended`'s payload takes a `mixActive` flag for exactly this:

```ts
watchParty.reduce(state, 'video-ended', {
  videoId: endedVideoId,
  mixActive: yourMixFeature.hasNextTrack(myRoom),
});
```

When `mixActive` is `true`, `reduce` does **nothing at all** — no queue
advance, no freeze, no effects. Your mix feature owns everything from that
point, including what happens if it turns out to have no candidate either.

This is a plain payload flag rather than a function injected into
`createWatchParty` (contrast `pickShuffleIndex`, which *is* injected at the
factory level) because whether a mix is active is dynamic, per-room state —
it can turn on or off between one `video-ended` call and the next. A
factory-level callback would go stale the instant that happens; your host
already knows the answer synchronously when it decides to call `reduce`, so
it's simplest for it to just say so.

### Why `pause` does nothing

This is a deliberate design decision, not a stub. `pause` applies **only to
the client that pressed it** — the shared server state (`isPlaying`,
`position`) is untouched, and nothing is broadcast to anyone else. `play` and
`seek` *do* affect the whole room, which makes `pause` doing nothing look
like an inconsistency at first glance, but pausing your own player (to
answer the door, say) shouldn't stop the video for everyone else. Every other
client — including the pauser's own state on reconnect — keeps playing from
the shared position untouched. The action is accepted (so a host doesn't have
to special-case it client-side) and always returns `null`.

### Shuffle

Watch Party's shuffle only ever avoids repeating the currently-playing item —
it's not "don't repeat until everyone's queue entry has played once." This
package doesn't implement that selection algorithm itself; you pass it in as
`pickShuffleIndex` when calling `createWatchParty`. This is deliberate: if
your app shares one shuffle implementation across Watch Party and some other
"random pick from a list" feature (so "random" means the same thing
everywhere), bundling a second implementation into this package would let the
two drift apart. If you don't need that guarantee, any function that returns
a valid index into the given `items` works, e.g.:

```ts
pickShuffleIndex: (items) => Math.floor(Math.random() * items.length)
```

Omit `pickShuffleIndex` entirely and shuffle is simply inert — `shuffleEnabled`
in the payload is ignored and the queue always advances FIFO.

## API

| Export | Signature | Meaning |
| --- | --- | --- |
| `createWatchParty` | `(options?: { pickShuffleIndex?, autoAdvanceBy? }) => WatchPartyStateApi` | Builds the API. Both options are optional. |
| `defaultState()` | `() => WatchPartyState` | An empty room: nothing loaded, empty queue/history. Also available as a top-level export (independent of `createWatchParty`'s options). |
| `currentPosition(state)` | `(state: WatchPartyState) => number` | The playback position right now, extrapolated by wall clock while playing. Also available as a top-level export. |
| `.reduce` | `(state, action, payload?) => { state, effects } \| null` | Applies one action. `null` means "ignore" (invalid or a no-op). |
| `.restore` | `(raw: unknown) => WatchPartyState \| null` | Normalizes state loaded from storage. `null` only for non-object input; playback always comes back stopped. |

`createWatchParty`'s options:

- `pickShuffleIndex?: (items, currentVideoId) => number` — see [Shuffle](#shuffle).
- `autoAdvanceBy?: string` — the `by` value stamped on items that start
  playing without a specific acting member (an empty room's first `queue-add`,
  or `video-ended`'s queue-advance). Defaults to `'queue'`. Lets your UI
  distinguish "the queue advanced this on its own" from "a member pressed
  play" — pass your own value if you want one distinct from real member names.

### Types

`WatchPartyState`, `WatchPartyProvider`, `WatchPartyQueueItem`,
`WatchPartyHistoryItem`, `WatchPartyAction`, `WatchPartyPayload`,
`WatchPartyEffect`, `CreateWatchPartyOptions`, and `WatchPartyStateApi` are
all exported. `reduce`'s `action` parameter is typed as `string` rather than
`WatchPartyAction` on purpose — it sits at a wire boundary where the action
name is untrusted input, and anything outside the known set falls through to
`null`.

### Keeping send order when you resolve metadata first

If your host awaits anything before calling `reduce` — looking up a duration to
enforce a cap, fetching a title — two adds sent back to back can land in the
opposite order, because whichever lookup finishes first gets to `reduce` first.
The queue would then show them swapped relative to what people actually sent.

Stamp arrival order *before* you await, and hand it in as `addSeq`:

```ts
// Capture arrival order synchronously, before any await.
seq += 1;
const addSeq = seq;

const durationSec = await lookUpDuration(videoId); // lands out of order

const out = watchParty.reduce(state, 'queue-add', { videoId, durationSec, addSeq });
```

`reduce` slots the item in by `addSeq` rather than appending, so send order
survives. Omit `addSeq` and it assigns one at call time — fine for a host that
never awaits first.

## Test

```sh
node --test
```

Every test either uses inputs with no time dependency or freezes `Date.now()`
for its duration, so the suite is fully deterministic — no real clocks, no
wall-clock waits.

## License

MIT
