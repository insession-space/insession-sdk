# @insession/pomodoro-state

A **dependency-free, server-authoritative Pomodoro timer state machine.**

Shared Pomodoro timers ("the whole room is on the same clock") are easy to get
subtly wrong: whoever owns the countdown has to agree with everyone else on
when a phase ends, survive a server restart without a fake countdown resuming
from garbage, and let people declare "what I'm doing this session" and cheer
each other on without turning the reducer into a database client.

This package is that state machine, with none of the plumbing:

- **Server holds the clock, clients don't tick.** While running, state carries
  `endsAt` — a wall-clock epoch ms — instead of a decrementing counter. Render
  the countdown from `endsAt` on the client; there is no need to broadcast
  every second.
- **`reduce` is a pure function.** `(state, action, payload) => nextState |
  null`. No I/O, no timers started inside it — `null` means "ignore this
  action" (e.g. `pause` while already stopped).
- **Declarations and cheers are built in.** Each member can post a one-line
  "what I'm doing" declaration and toggle cheers on others' declarations,
  scoped and clamped for you.
- **`restore` is defensive by design.** Feed it whatever your storage layer
  handed back — even malformed JSON — and it returns a safe, always-stopped
  state, with caps on declaration/cheer counts.
- **Zero runtime dependencies.** Pure functions over plain objects. The only
  "impure" thing anywhere in the package is `Date.now()`, read by the actions
  that move the clock (`start`, `pause`, `skip`) and by `timerDelay`/`onTimer`.
  `restore` and `persistState` never touch it, so replaying stored state is
  fully deterministic.

## Install

```sh
npm install @insession/pomodoro-state
```

Published as a built package with both ESM (`dist/index.js`) and CommonJS
(`dist/index.cjs`) entry points plus `dist/index.d.ts` types, no runtime
dependencies.

## Usage

```ts
import {
  defaultState,
  onTimer,
  persistState,
  reduce,
  restore,
  timerDelay,
  type PomodoroState,
} from '@insession/pomodoro-state';

// Somewhere you keep one PomodoroState per room, e.g. a Map<roomId, PomodoroState>.
let state: PomodoroState = defaultState();

// A client action arrives over your transport (WebSocket, etc). `by` identifies
// the acting member; it's your call how you derive it (session, auth, ...).
function onClientAction(action: string, payload: unknown) {
  const next = reduce(state, action, payload as Record<string, unknown>);
  if (!next) return; // invalid or a no-op — nothing changed, nothing to broadcast
  state = next;
  broadcastToRoom({ type: 'pomodoro-state', state });
  schedulePhaseTimer();
}

// Drive phase transitions with your own timer (setTimeout, a job queue, ...).
let phaseTimer: ReturnType<typeof setTimeout> | undefined;
function schedulePhaseTimer() {
  clearTimeout(phaseTimer);
  const delay = timerDelay(state);
  if (delay === null) return; // not running — nothing to schedule
  phaseTimer = setTimeout(() => {
    state = onTimer(state);
    broadcastToRoom({ type: 'pomodoro-state', state });
    schedulePhaseTimer();
  }, delay);
}

// Load from storage on room startup / first join.
function loadFromDb(raw: unknown) {
  state = restore(raw) ?? defaultState();
}

// Before writing to storage, strip the session-only participants map.
function saveToDb() {
  db.write(persistState(state));
}
```

### Actions

`reduce(state, action, payload)` accepts these `action` strings:

| Action | Payload | Effect |
| --- | --- | --- |
| `start` | — | Starts the timer from `remaining`. No-op (`null`) if already running. |
| `pause` | — | Stops the timer, freezing `remaining`. No-op if already stopped. |
| `reset` | — | Re-initializes phase/cycles/timer, but **keeps** `config`, `declarations`, and `participants`. |
| `skip` | — | Advances to the next phase immediately, without counting a completed cycle. |
| `configure` | `{ workMinutes?, breakMinutes? }` | Sets phase lengths (clamped 1–120 min). Only while stopped. Values that convert to a number (including `null`, `''`, `false`, `[]`, which all convert to `0`) are clamped to 1 minute rather than falling back to the current config — only values that don't convert to a finite number (e.g. `'nope'`, `undefined`) fall back. |
| `declare` | `{ by, text?, uid? }` | Sets (or, with empty `text`, clears) `by`'s one-line declaration. |
| `cheer` | `{ target, by }` | Toggles `by`'s cheer on `target`'s declaration. No-op on self-cheers or undeclared targets. |
| `join` | `{ by, uid? }` | Marks `by` as participating in this session. |
| `leave` | `{ by }` | Removes `by` from the session's participants. |

Any other `action` string returns `null`. Because the payload arrives over the
wire, every field is treated as untrusted and validated at the point of use —
`reduce` never throws on malformed input; it returns `null` instead.

## API

| Export | Signature | Meaning |
| --- | --- | --- |
| `defaultState()` | `() => PomodoroState` | A fresh, stopped 25/5-minute state with no declarations or participants. |
| `reduce` | `(state, action, payload?) => PomodoroState \| null` | Applies one action. `null` means "ignore" (invalid or a no-op). |
| `timerDelay` | `(state) => number \| null` | Milliseconds until the current phase ends, or `null` if not running. |
| `onTimer` | `(state) => PomodoroState` | Called once `timerDelay` elapses: advances the phase and keeps running. |
| `restore` | `(raw: unknown) => PomodoroState \| null` | Normalizes state loaded from storage. `null` only for non-object input; otherwise always stopped, with caps applied. |
| `persistState` | `(state) => PomodoroState` | Strips `participants` before writing to storage (it's session-only). |

### Types

`PomodoroState`, `PomodoroPhase`, `PomodoroConfig`, `PomodoroDeclaration`,
`PomodoroParticipant`, `PomodoroAction`, and `PomodoroPayload` are all
exported. `reduce`'s `action` parameter is typed as `string` rather than
`PomodoroAction` on purpose — it sits at a wire boundary where the action name
is untrusted input, and anything outside the known set falls through to
`null`.

### Why `participants` isn't persisted

`state.participants` answers "who is in this session right now" — a signal
that only makes sense while people are actually connected. `restore` always
returns it empty, and `persistState` strips it before a write, so a stale
membership list never survives a restart or lingers unread in storage.

### Why `declarations` survive `reset`/`skip`

A declaration is "what I'm doing this session", not per-phase state — `reset`
re-initializes the timer, it doesn't reset intent. Only declarations with a
`uid` are kept by `restore`; a guest's declaration lives only in the
in-memory state you pass to `reduce` and is intentionally dropped on reload.

## Test

```sh
node --test
```

Every test either uses inputs with no time dependency or freezes `Date.now()`
for its duration, so the suite is fully deterministic — no real clocks, no
wall-clock waits.

## License

MIT
