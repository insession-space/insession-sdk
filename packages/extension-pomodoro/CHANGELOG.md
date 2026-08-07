# @insession/extension-pomodoro

## 0.3.1

### Patch Changes

- 38bb35d: Fix README code examples that were still written against the pre-effects API,
  and drop the historical rename notices.

  `reduce`/`onTimer` return `{ state, effects } | null`, but the Usage blocks in
  `extension-pomodoro` and `extension-whiteboard` still assigned the result
  straight to `state` — which contradicted the API tables in the same files.
  Whiteboard's example also ignored the effects-only result shape used by the
  live relay frames. Both now show the real shape, including a `runEffect` helper
  that matches what the Effects section describes.

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

> Renamed from `@insession/plugin-pomodoro-state` at 0.2.0. Entries below 0.2.0 were published under the old name.

## 0.1.0

### Minor Changes

- b471a25: Add `@insession/plugin-pomodoro-state`, a dependency-free, server-authoritative Pomodoro timer state machine.

  Ported from the server-side reducer of InSession's Pomodoro plugin — the pure `reduce` / `timerDelay` / `onTimer` / `restore` / `persistState` functions only, with no UI, i18n, or design-system dependency. Full TypeScript types were added, and the package ships both ESM and CJS builds so hosts that `require()` it keep working.

  Behavior matches the implementation it was ported from, with a few deliberate exceptions. Payload fields naming a member (`by`, `target`) are now rejected when they are not strings, instead of being coerced into an object key. Coercion would let a caller address a member through a value that merely stringifies to their name, and would allow non-strings to reach the `cheers: string[]` array. Member-name lookups (`declare`/`cheer`/`join`/`leave`) also now use `Object.hasOwn` guards, so a wire-controlled name like `'constructor'` or `'toString'` can no longer resolve to an inherited `Object.prototype` value and crash or misbehave — the ported source has the same bug, but this package fixes it rather than reproducing it. `uid` is now normalized (`typeof uid === 'string' ? uid : null`) instead of blindly cast, so a non-string `uid` can no longer end up stored in state and then silently dropped by `restore` on the next reload. Finally, `restore` defines declaration keys rather than assigning them, so a member whose display name is `'__proto__'` round-trips as an own key instead of replacing the returned object's prototype with stored data.
