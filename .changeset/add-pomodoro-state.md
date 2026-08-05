---
"@insession/pomodoro-state": minor
---

Add `@insession/pomodoro-state`, a dependency-free, server-authoritative Pomodoro timer state machine.

Ported from the server-side reducer of InSession's Pomodoro plugin — the pure `reduce` / `timerDelay` / `onTimer` / `restore` / `persistState` functions only, with no UI, i18n, or design-system dependency. Full TypeScript types were added, and the package ships both ESM and CJS builds so hosts that `require()` it keep working.

Behavior matches the implementation it was ported from, with a few deliberate exceptions. Payload fields naming a member (`by`, `target`) are now rejected when they are not strings, instead of being coerced into an object key. Coercion would let a caller address a member through a value that merely stringifies to their name, and would allow non-strings to reach the `cheers: string[]` array. Member-name lookups (`declare`/`cheer`/`join`/`leave`) also now use `Object.hasOwn` guards, so a wire-controlled name like `'constructor'` or `'toString'` can no longer resolve to an inherited `Object.prototype` value and crash or misbehave — the ported source has the same bug, but this package fixes it rather than reproducing it. `uid` is now normalized (`typeof uid === 'string' ? uid : null`) instead of blindly cast, so a non-string `uid` can no longer end up stored in state and then silently dropped by `restore` on the next reload. Finally, `restore` defines declaration keys rather than assigning them, so a member whose display name is `'__proto__'` round-trips as an own key instead of replacing the returned object's prototype with stored data.
