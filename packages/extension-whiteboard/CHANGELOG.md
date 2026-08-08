# @insession/extension-whiteboard

## 0.4.2

### Patch Changes

- 64175ea: Split each state machine's single `index.ts` into modules (`types` / `sanitize` / `state` / `reduce` / `extension`, plus `relay` for whiteboard, `playback` for watch party, `persist` for pomodoro). `index.ts` is now nothing but the package's public surface.

  No behavior change and no API change: every exported symbol and its type signature is identical, and the existing tests pass unmodified against the same entry point.

## 0.4.1

### Patch Changes

- 38bb35d: Fix README code examples that were still written against the pre-effects API,
  and drop the historical rename notices.

  `reduce`/`onTimer` return `{ state, effects } | null`, but the Usage blocks in
  `extension-pomodoro` and `extension-whiteboard` still assigned the result
  straight to `state` — which contradicted the API tables in the same files.
  Whiteboard's example also ignored the effects-only result shape used by the
  live relay frames. Both now show the real shape, including a `runEffect` helper
  that matches what the Effects section describes.

## 0.4.0

### Minor Changes

- aa09386: Add a `relay` action for live drawing frames

  Confirmed strokes go through `reduce`, get stored and broadcast, and come back for late joiners. The line **being drawn right now** is a different thing: a frame per pointer move, worth forwarding to whoever is watching and worth nothing a second later. Storing those would flood the host's database and the wire.

  Until now this package had nothing to say about them, so a host had to build its own fan-out path beside the extension — which meant **any registered extension could relay anything through it**, whether or not it had any use for relay.

  ```ts
  board.reduce(state, "relay", { payload: frame });
  // -> { effects: [{ type: 'relay', payload: frame }] }   ← no `state`
  ```

  Returning effects with no `state` (`@insession/space@0.2.0`) is what makes this work: nothing is stored, no board update is broadcast, and — the part that matters — **the relay phase timer is not re-armed**. People draw _during_ the draw phase, so re-arming on every frame would keep a countdown that is supposed to run out from ever running out.

  `payload` is **opaque on purpose**. What a frame contains — a partial stroke, a whole board at reduced fidelity, a cursor position — is a contract between your drawing client and your renderer, and it changes whenever that UI grows a feature. Teaching this package the shape would drag UI churn into a package that is supposed to be stable. What it _does_ decide is that the whiteboard accepts relay at all: an extension that never returns a `relay` effect simply cannot be relayed through.

  `WhiteboardReduceResult` is now a union (`{ state, effects } | { effects }`). Callers that read `.state` off it should narrow with `'state' in result` first.

## 0.3.0

### Minor Changes

- 2d9ef3f: `reduce`/`onTimer` return `{ state, effects }` instead of a bare state

  Both packages had one thing that outlives a session and therefore needs the host's storage — a Pomodoro member's one-line declaration, and a finished relay album. Until now the host had to _infer_ those writes by diffing the previous and next state after every transition. That works, but it puts knowledge of "what a declaration change looks like" in the host, and it runs on transitions that could not possibly have changed anything.

  The transition already knows. So it says so, the same way `@insession/extension-watch-party` and `@insession/extension-chat` already do.

  **`@insession/extension-pomodoro`**

  | Effect                                       | When                                                |
  | -------------------------------------------- | --------------------------------------------------- |
  | `{ type: 'persist-declaration', uid, text }` | A signed-in member declared, or changed their text. |
  | `{ type: 'delete-declaration', uid }`        | A signed-in member cleared their declaration.       |

  Guests produce no effects — a guest has no account to key storage by, so their declaration lives in state and nowhere else. Cheering produces none either: cheers are not stored.

  **`@insession/extension-whiteboard`**

  | Effect                                               | When                                                            |
  | ---------------------------------------------------- | --------------------------------------------------------------- |
  | `{ type: 'persist-relay-history', players, chains }` | The relay reaches its album, from either `reduce` or `onTimer`. |

  Fired exactly once per game, on the edge into the album; a rematch produces its own single effect.

  ### ⚠ Breaking for direct callers

  `reduce` returned `State | null` and now returns `{ state, effects } | null`; `onTimer` changed the same way. **Consumers going through `createExtensionRegistry` from `@insession/space` need no change** — it accepts both shapes. Callers holding the functions directly unwrap one level:

  ```diff
  -const next = reduce(state, action, payload);
  -if (next) state = next;
  +const result = reduce(state, action, payload);
  +if (result) {
  +  state = result.state;
  +  for (const effect of result.effects) run(effect);
  +}
  ```

  All four state-machine packages now share one signature, which is what the shape was always converging on.

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
