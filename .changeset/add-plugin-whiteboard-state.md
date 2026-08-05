---
"@insession/plugin-whiteboard-state": minor
---

Add `@insession/plugin-whiteboard-state`, a dependency-free, server-authoritative Whiteboard state machine: a shared free-draw canvas (strokes + shapes) plus an optional "drawing telephone" relay game.

Ported from the server-side reducer of InSession's Whiteboard plugin — the pure `reduce` / `timerDelay` / `onTimer` / `restore` functions only, with no UI, i18n, or design-system dependency. Full TypeScript types were added, and the package ships both ESM and CJS builds so hosts that `require()` it keep working.

The one external dependency in the ported source — validating a submitted drawing's image URL against the host's own storage — could not be baked into this package (it's inherently host-specific: bucket, domain, signing scheme). It's exposed instead as a required `isOwnImageUrl` predicate passed to a factory, `createWhiteboardState({ isOwnImageUrl })`, which returns the full API (`defaultState`/`reduce`/`timerDelay`/`onTimer`/`restore`). `isOwnImageUrl` has no "accept everything" default: a host that forgets to pass it gets an immediate throw rather than silently accepting arbitrary external URLs into shared state.

Behavior otherwise matches the implementation this package was ported from. No prototype-pollution-style fixes were needed here (unlike `@insession/plugin-pomodoro-state`): this state machine never uses a wire-controlled string as an object key — player names live in arrays, and shapes/strokes are looked up by `.find`/`.filter` over arrays, not by keyed property access — so there was no `Object.prototype` collision or `__proto__` assignment hazard to guard against.
