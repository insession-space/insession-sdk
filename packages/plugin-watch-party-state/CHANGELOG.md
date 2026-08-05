# @insession/plugin-watch-party-state

## 0.1.0

### Minor Changes

- d4a442d: Add `@insession/plugin-watch-party-state`, a dependency-free, server-authoritative Watch Party state machine: synchronized video/audio playback (YouTube or SoundCloud) with a queue and history.

  Ported from the server-side reducer of InSession's Watch Party plugin — the pure state-transition logic only, with no UI, i18n, or design-system dependency. Unlike `plugin-pomodoro-state`/`plugin-whiteboard-state`, this plugin has genuine side effects (broadcast, DB persistence, title/duration lookup), so `reduce` returns `{ state, effects }` instead of performing I/O itself, following the same effect-descriptor convention `@insession/space-state`'s `reduceSpace` uses. The one remaining external dependency — the shuffle selection algorithm, shared with an unrelated feature in the app this was ported from — is injected via `createWatchParty({ pickShuffleIndex })`, the same pattern `plugin-whiteboard-state` uses for `isOwnImageUrl`. Ships both ESM and CJS builds so hosts that `require()` it keep working.
