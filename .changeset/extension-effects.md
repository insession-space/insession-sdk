---
'@insession/extension-pomodoro': minor
'@insession/extension-whiteboard': minor
---

`reduce`/`onTimer` return `{ state, effects }` instead of a bare state

Both packages had one thing that outlives a session and therefore needs the host's storage — a Pomodoro member's one-line declaration, and a finished relay album. Until now the host had to *infer* those writes by diffing the previous and next state after every transition. That works, but it puts knowledge of "what a declaration change looks like" in the host, and it runs on transitions that could not possibly have changed anything.

The transition already knows. So it says so, the same way `@insession/extension-watch-party` and `@insession/extension-chat` already do.

**`@insession/extension-pomodoro`**

| Effect | When |
| --- | --- |
| `{ type: 'persist-declaration', uid, text }` | A signed-in member declared, or changed their text. |
| `{ type: 'delete-declaration', uid }` | A signed-in member cleared their declaration. |

Guests produce no effects — a guest has no account to key storage by, so their declaration lives in state and nowhere else. Cheering produces none either: cheers are not stored.

**`@insession/extension-whiteboard`**

| Effect | When |
| --- | --- |
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
