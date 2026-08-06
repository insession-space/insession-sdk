# @insession/extension-whiteboard

> Renamed from `@insession/plugin-whiteboard-state` at 0.2.0. Entries below 0.2.0 were published under the old name.

## 0.1.1

### Patch Changes

- 290d822: Fix `ReferenceError: Buffer is not defined` in browsers

  The shape byte cap used Node's `Buffer.byteLength`, so `add-shape` and `update-shape` threw in any browser — `0.1.0` is unusable client-side. It now uses `TextEncoder`, which exists in both runtimes and counts the same UTF-8 bytes (verified across multi-byte text, emoji and lone surrogates), so the cap itself is unchanged.

  A regression test now asserts that the source reaches for no Node-only globals. This class of bug is invisible to Node-side tests, which is exactly how it shipped: it only surfaced when the package was loaded in a real browser.

## 0.1.0

### Minor Changes

- 934acf9: Add `@insession/plugin-whiteboard-state`, a dependency-free, server-authoritative Whiteboard state machine: a shared free-draw canvas (strokes + shapes) plus an optional "drawing telephone" relay game.

  Ported from the server-side reducer of InSession's Whiteboard plugin — the pure `reduce` / `timerDelay` / `onTimer` / `restore` functions only, with no UI, i18n, or design-system dependency. Full TypeScript types were added, and the package ships both ESM and CJS builds so hosts that `require()` it keep working.

  The one external dependency in the ported source — validating a submitted drawing's image URL against the host's own storage — could not be baked into this package (it's inherently host-specific: bucket, domain, signing scheme). It's exposed instead as a required `isOwnImageUrl` predicate passed to a factory, `createWhiteboardState({ isOwnImageUrl })`, which returns the full API (`defaultState`/`reduce`/`timerDelay`/`onTimer`/`restore`). `isOwnImageUrl` has no "accept everything" default: a host that forgets to pass it gets an immediate throw rather than silently accepting arbitrary external URLs into shared state.

  Behavior otherwise matches the implementation this package was ported from. No prototype-pollution-style fixes were needed here (unlike `@insession/plugin-pomodoro-state`): this state machine never uses a wire-controlled string as an object key — player names live in arrays, and shapes/strokes are looked up by `.find`/`.filter` over arrays, not by keyed property access — so there was no `Object.prototype` collision or `__proto__` assignment hazard to guard against.
