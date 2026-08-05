---
"@insession/pomodoro-state": minor
---

Add `@insession/pomodoro-state`, a dependency-free, server-authoritative Pomodoro timer state machine.

Ported from the server-side reducer of InSession's Pomodoro plugin — the pure `reduce` / `timerDelay` / `onTimer` / `restore` / `persistState` functions only, with no UI, i18n, or design-system dependency. Full TypeScript types were added, and the package ships both ESM and CJS builds so hosts that `require()` it keep working.

Behavior matches the implementation it was ported from, with one deliberate exception: payload fields naming a member (`by`, `target`) are now rejected when they are not strings, instead of being coerced into an object key. Coercion would let a caller address a member through a value that merely stringifies to their name, and would allow non-strings to reach the `cheers: string[]` array.
