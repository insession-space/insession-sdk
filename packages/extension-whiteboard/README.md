# @insession/extension-whiteboard

A **dependency-free, server-authoritative Whiteboard state machine**: a
shared free-draw canvas (strokes + shapes) with an optional "drawing
telephone" relay game bolted on.

Shared whiteboards ("everyone draws on the same canvas, live") are easy to
get subtly wrong: an unbounded array of strokes grows forever, a malicious
payload can smuggle megabytes into shared state, and a submitted image URL
can point anywhere on the internet unless something checks it. A relay game
on top adds its own class of bugs — phase timing, who's turn it is, what
happens when someone never submits.

This package is that state machine, with none of the plumbing:

- **`reduce` is a pure function.** `(state, action, payload) => nextState |
  null`. No I/O, no timers started inside it — `null` means "ignore this
  action" (e.g. adding a shape past the cap, or an empty `clear`).
- **Confirmed strokes/shapes only.** In-progress drawing (live cursor
  preview) is out of scope on purpose — that belongs on a lower-latency,
  unvalidated relay channel you build yourself. This module only cares about
  strokes/shapes once they're finished.
- **Every input is capped.** Stroke count, points per stroke, shape count,
  shape text length, and serialized shape size are all bounded, so a
  malicious or buggy client can't grow shared state without limit.
- **The relay game is a small phase machine.** `prompt → draw → guess →
  ... → album`, driven the same way as the rest of this SDK's timers:
  `timerDelay`/`onTimer` for expiry, with a grace period so a client's
  own auto-submit has a chance to land before a placeholder fills in for it.
- **`restore` is defensive by design.** Feed it whatever your storage layer
  handed back — even malformed JSON — and it returns a safe state with caps
  applied. A relay game in progress does not survive a restart (same
  reasoning as a saved playback position: come back stopped, not resumed
  against a clock that's no longer valid).
- **The only "impure" thing anywhere in the package is `Date.now()`.**

## Why a factory instead of plain exports

Accepting a submitted drawing's image URL (the `submit-drawing` action) means
deciding whether that URL is trustworthy. This package can't know your
storage's bucket, domain, or signing scheme, so it doesn't guess — you pass a
predicate:

```ts
import { createWhiteboardState } from '@insession/extension-whiteboard';

const whiteboard = createWhiteboardState({
  isOwnImageUrl: (url) => url.startsWith('https://cdn.example.com/uploads/'),
});
```

`isOwnImageUrl` is **required**. There is no "accept everything" default —
that would mean a host that forgets to pass it silently accepts arbitrary
external URLs into shared state, which is exactly the kind of hole that goes
unnoticed until it's exploited. A missing or non-function value throws
immediately when you call `createWhiteboardState`.

The returned object bundles all five functions (`defaultState`, `reduce`,
`timerDelay`, `onTimer`, `restore`) so you never have to remember which one
needed the predicate and which didn't (only `reduce` actually reads it, via
the `submit-drawing` action). `defaultState` is also available as a
top-level named export, since it's the one function that's obviously
independent of `isOwnImageUrl` even without looking at the implementation —
useful if you just need a fallback/initial value.

## Install

```sh
npm install @insession/extension-whiteboard
```

Published as a built package with both ESM (`dist/index.js`) and CommonJS
(`dist/index.cjs`) entry points plus `dist/index.d.ts` types, no runtime
dependencies.

> Renamed from `@insession/plugin-whiteboard-state` at 0.2.0. The old name is
> deprecated on npm; the API is unchanged apart from the addition of
> `whiteboardExtension` below.

## Drop it into a space

If you are assembling a space with
[`@insession/space`](https://www.npmjs.com/package/@insession/space), the whole
integration is one line — the extension carries its own name, reducer, relay
timers and persistence rules:

```ts
import { createSpace } from '@insession/space';
import { whiteboardExtension } from '@insession/extension-whiteboard';

const space = createSpace({
  extensions: [whiteboardExtension({ isOwnImageUrl: (url) => url.startsWith(MY_BUCKET) })],
});

space.dispatch('whiteboard', 'add-stroke', { stroke }); // -> [broadcast, clear-timer]
```

`isOwnImageUrl` is required here for exactly the reason it is required by
`createWhiteboardState` — see below. Pass `{ name }` to occupy a different key.

Nothing is imported from `@insession/space` to build that object: it satisfies
that package's `SpaceExtension` structurally, so this package keeps its zero
dependencies and everything below still works without it.

## Usage

```ts
import {
  createWhiteboardState,
  type WhiteboardState,
} from '@insession/extension-whiteboard';

const whiteboard = createWhiteboardState({
  isOwnImageUrl: (url) => url.startsWith('https://cdn.example.com/uploads/'),
});

// Somewhere you keep one WhiteboardState per board, e.g. a Map<boardId, WhiteboardState>.
let state: WhiteboardState = whiteboard.defaultState();

// A client action arrives over your transport (WebSocket, etc). `by` identifies
// the acting member; it's your call how you derive it (session, auth, ...).
function onClientAction(action: string, payload: unknown) {
  const next = whiteboard.reduce(state, action, payload as Record<string, unknown>);
  if (!next) return; // invalid or a no-op — nothing changed, nothing to broadcast
  state = next;
  broadcastToBoard({ type: 'extension-whiteboard', state });
  scheduleRelayTimer();
}

// Drive relay-game phase transitions with your own timer (setTimeout, a job queue, ...).
let relayTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleRelayTimer() {
  clearTimeout(relayTimer);
  const delay = whiteboard.timerDelay(state);
  if (delay === null) return; // no relay game running — nothing to schedule
  relayTimer = setTimeout(() => {
    const next = whiteboard.onTimer(state);
    if (!next) return;
    state = next;
    broadcastToBoard({ type: 'extension-whiteboard', state });
    scheduleRelayTimer();
  }, delay);
}

// Load from storage on board startup / first join.
function loadFromDb(raw: unknown) {
  state = whiteboard.restore(raw) ?? whiteboard.defaultState();
}
```

In-progress strokes (the live preview while someone is still drawing) are
not part of this state machine — relay those over your transport directly,
unvalidated and unsaved, and only hand a stroke to `reduce`'s `add-stroke`
once the pointer is released.

### Actions

`reduce(state, action, payload)` accepts these `action` strings:

| Action | Payload | Effect |
| --- | --- | --- |
| `add-stroke` | `{ stroke }` | Adds (or, on a matching id, replaces) a confirmed freedraw stroke. Oldest strokes are dropped past 2000. |
| `erase` | `{ ids }` | Removes strokes by id. No-op if none match. |
| `clear` | — | Empties **both** strokes and shapes (a "clear the board" that only cleared strokes would leave shapes behind). No-op if already empty. |
| `add-shape` | `{ shape }` | Adds (or, on a matching id *and* type, replaces) a shape (rectangle/ellipse/connector/text/sticky/...). Rejected past 500 shapes, or if reusing an id with a different type. |
| `update-shape` | `{ id, patch }` | Partially updates a shape. `id`/`type` cannot be changed by a patch. No-op if the patch is empty/invalid. |
| `remove-shape` | `{ ids }` | Removes shapes by id. No-op if none match. |
| `set-mode` | — | Always a no-op, kept only for backward compatibility with older clients. Setting `game: null` here would let anyone silently discard an in-progress relay game. |
| `join-game` | `{ by }` | Joins the relay game's lobby (lazily created on first join). Rejected once full (8 players) or once the game has started. |
| `leave-game` | `{ by }` | Leaves the lobby. Only valid while still in `lobby`. |
| `start-game` | — | Starts the relay game (needs ≥2 players). Moves to the `prompt` phase. |
| `reset-game` | — | Returns from `album` to a fresh lobby, keeping the same players. |
| `submit-prompt` | `{ by, text }` | Submits a prompt during the `prompt` phase. |
| `submit-drawing` | `{ by, imageUrl }` | Submits a drawing during the `draw` phase. `imageUrl` must satisfy `isOwnImageUrl`. |
| `submit-guess` | `{ by, text }` | Submits a guess during the `guess` phase. |

Any other `action` string returns `null`. Because the payload arrives over
the wire, every field is treated as untrusted and validated at the point of
use — `reduce` never throws on malformed input; it returns `null` instead.

## API

| Export | Signature | Meaning |
| --- | --- | --- |
| `createWhiteboardState` | `(options: { isOwnImageUrl: (url: string) => boolean }) => WhiteboardStateApi` | Builds the API. Throws if `isOwnImageUrl` is missing or not a function. |
| `defaultState()` | `() => WhiteboardState` | An empty, free-mode board with no relay game. Also available as a top-level export (see above). |
| `.reduce` | `(state, action, payload?) => WhiteboardState \| null` | Applies one action. `null` means "ignore" (invalid or a no-op). |
| `.timerDelay` | `(state) => number \| null` | Milliseconds until the current relay phase expires (plus a grace period), or `null` if no relay game is running. |
| `.onTimer` | `(state) => WhiteboardState \| null` | Called once `timerDelay` elapses: fills a placeholder for anyone who hasn't submitted, then advances the round. `null` if there's no game. |
| `.restore` | `(raw: unknown) => WhiteboardState \| null` | Normalizes state loaded from storage. `null` only for non-object input; otherwise strokes/shapes are filtered and capped, `mode` is always `'free'`, and `game` is always `null`. |

### Types

`WhiteboardState`, `WhiteboardMode`, `WhiteboardStroke`, `WhiteboardStrokePoint`,
`WhiteboardStrokeStyle`, `WhiteboardShape`, `WhiteboardShapeType`,
`WhiteboardShapeStyle`, `AnchorType`, `PathType`, `ArrowHead`, `RelayPhase`,
`RelayGame`, `RelayChainEntry`, `WhiteboardAction`, `WhiteboardPayload`, and
`WhiteboardStateApi` are all exported. `reduce`'s `action` parameter is typed
as `string` rather than `WhiteboardAction` on purpose — it sits at a wire
boundary where the action name is untrusted input, and anything outside the
known set falls through to `null`.

### Why in-progress strokes aren't this module's concern

Only *confirmed* strokes (pointer released) belong in shared state — they're
validated, persisted, and broadcast to everyone including late joiners (via
`restore`). The live preview while someone is mid-stroke is high-frequency
and disposable: relaying every pointer move through `reduce`, storage, and a
full-state broadcast would be wasteful and unnecessary. Send that over your
transport directly, unvalidated, and only call `reduce`'s `add-stroke` once
the stroke is done.

### Why `clear` empties shapes too

"Clear the board" means the board goes back to blank — a `clear` that only
removed strokes and left shapes behind would violate that expectation
silently.

### Why `timerDelay` adds a grace period

Clients auto-submit their in-progress prompt/drawing/guess the instant their
local countdown reaches zero, but that auto-submit still has to cross the
network. If `onTimer`'s "fill placeholders for whoever hasn't submitted" pass
fired the instant the phase's nominal duration elapsed, it could win the race
against a submission that was already on its way and silently overwrite it
with an empty placeholder. Adding a grace period to `timerDelay` gives the
auto-submit a window to land first — `submitToChain` skips anyone already
submitted, so `onTimer` simply leaves them alone when it does.

## Test

```sh
node --test
```

Every test either uses inputs with no time dependency or freezes `Date.now()`
for its duration, so the suite is fully deterministic — no real clocks, no
wall-clock waits.

## License

MIT
