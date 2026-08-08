// Server-authoritative Watch Party state machine: synchronized playback of a
// single "now playing" item (YouTube video or SoundCloud track) plus a queue
// and a play history.
//
// Sync model: the server owns `videoId`/`provider`/`isPlaying`/`position`.
// While playing, position is *not* ticked every second — it's derived on
// demand by wall-clock extrapolation (`currentPosition`), so the server only
// has to broadcast on actual play/pause/seek/load events (plus an occasional
// `request-sync` for a client that needs to catch up, e.g. after returning
// from a backgrounded tab).
//
// Unlike `extension-whiteboard`/`extension-pomodoro`, this module
// genuinely has side effects worth doing (broadcast a message, persist
// playback position, ask the host to resolve a title). Rather than take
// callbacks, `reduce` returns `{ state, effects }` — a list of effect
// descriptors the host interprets and executes — following the same
// convention `@insession/space-state`'s `reduceSpace` already uses. This
// keeps `reduce` itself pure and testable without mocking I/O.
//
// `null` return value means "ignore this action" (invalid payload, or a
// genuine no-op — e.g. seeking with a garbage position, or `pause`, which is
// *always* a no-op by design; see its case in `reduce.ts`).
//
// This file is the package's public surface and nothing else: every export
// below is re-exported from the module that implements it. Keep it that way —
// the modules are free to move code between themselves, but what a consumer
// can import is decided here, in one readable list.
//
//   types.ts     — wire and state shapes (types only)
//   sanitize.ts  — normalization and caps, shared by both boundaries
//   playback.ts  — position, "now playing", and how the queue advances
//   state.ts     — defaultState
//   reduce.ts    — the action boundary, its effects, and restore
//   extension.ts — the same thing packaged for @insession/space

export { type WatchPartyExtensionOptions, watchPartyExtension } from './extension.ts';
export { currentPosition } from './playback.ts';
export { createWatchParty } from './reduce.ts';
export { defaultState } from './state.ts';
export type {
  CreateWatchPartyOptions,
  WatchPartyAction,
  WatchPartyEffect,
  WatchPartyHistoryItem,
  WatchPartyPayload,
  WatchPartyProvider,
  WatchPartyQueueItem,
  WatchPartyReduceResult,
  WatchPartyState,
  WatchPartyStateApi,
} from './types.ts';
