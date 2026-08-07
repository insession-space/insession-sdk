# @insession/extension-watch-party

## 0.4.2

### Patch Changes

- 38bb35d: Fix README code examples that were still written against the pre-effects API,
  and drop the historical rename notices.

  `reduce`/`onTimer` return `{ state, effects } | null`, but the Usage blocks in
  `extension-pomodoro` and `extension-whiteboard` still assigned the result
  straight to `state` — which contradicted the API tables in the same files.
  Whiteboard's example also ignored the effects-only result shape used by the
  live relay frames. Both now show the real shape, including a `runEffect` helper
  that matches what the Effects section describes.

> Renamed from `@insession/plugin-watch-party-state` at 0.4.0. Entries below 0.4.0 were published under the old name.

## 0.3.0

### Minor Changes

- 64444c6: `queue-add` accepts a host-supplied `uid`

  Queue items got a counter-based id (`q1`, `q2`, ...), which is only safe while the whole queue lives in memory: the counter restarts at zero when a stored queue is reloaded, so restored items and freshly added ones end up sharing ids. A host that persists its queue under its own ids — a database primary key it later uses to delete or reorder — can now pass that id as `uid` and keep storage and state pointed at the same item.

  Omitting `uid` keeps the counter-based fallback.

## 0.2.0

### Minor Changes

- 7504bbb: `queue-add` accepts a host-supplied `addSeq`

  A host that awaits anything before calling `reduce` — looking up a duration to enforce a cap, fetching a title — can now stamp arrival order itself and pass it as `addSeq`. Without it, `reduce` assigned the ordering number at call time, which records _landing_ order: two adds sent back to back swapped places whenever the second one's lookup resolved first, and the queue no longer matched what people sent.

  Omitting `addSeq` keeps the previous behaviour, which is still correct for hosts that never await before reducing.

## 0.1.0

### Minor Changes

- d4a442d: Add `@insession/plugin-watch-party-state`, a dependency-free, server-authoritative Watch Party state machine: synchronized video/audio playback (YouTube or SoundCloud) with a queue and history.

  Ported from the server-side reducer of InSession's Watch Party plugin — the pure state-transition logic only, with no UI, i18n, or design-system dependency. Unlike `plugin-pomodoro-state`/`plugin-whiteboard-state`, this plugin has genuine side effects (broadcast, DB persistence, title/duration lookup), so `reduce` returns `{ state, effects }` instead of performing I/O itself, following the same effect-descriptor convention `@insession/space-state`'s `reduceSpace` uses. The one remaining external dependency — the shuffle selection algorithm, shared with an unrelated feature in the app this was ported from — is injected via `createWatchParty({ pickShuffleIndex })`, the same pattern `plugin-whiteboard-state` uses for `isOwnImageUrl`. Ships both ESM and CJS builds so hosts that `require()` it keep working.
