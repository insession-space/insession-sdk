// Server-authoritative chat state machine for a realtime shared room:
// message normalization, sticker validation, replies, per-message emoji
// reactions, a typing indicator, and a pinned message.
//
// Storage model: unlike `extension-pomodoro`/`extension-watch-party`,
// almost nothing here lives in memory. The message log itself is owned by the
// host's database — this package never holds a transcript. The only genuine
// in-memory state is `pinnedMessage`, the one message a room has singled out.
// What this package actually owns is the *decisions*: what counts as a valid
// message, what gets normalized away, what goes on the wire, and which side
// effects the host must perform.
//
// Like `extension-watch-party`, `reduce` returns `{ state, effects }` — a
// list of effect descriptors the host interprets and executes (write to its
// DB, broadcast over its transport, hand the text to a bot) — rather than
// taking callbacks. This mirrors the convention `@insession/space-state`'s
// `reduceSpace` already uses and keeps `reduce` pure and testable without
// mocking I/O.
//
// ## Two-step actions
//
// Three flows need a value only the host's storage can produce, so they are
// split across two `reduce` calls, exactly like `extension-watch-party`'s
// `resolve-metadata` round trip:
//
// | first action     | effect the host runs                  | feed the result back as |
// | ---------------- | ------------------------------------- | ----------------------- |
// | `chat`           | `persist-chat` (insert, resolve reply) | `chat-persisted`        |
// | `chat-reaction`  | `toggle-reaction` (toggle, re-count)   | `chat-reaction-toggled` |
// | `pin-message`    | `resolve-message` (look the message up)| `pin-message-resolved`  |
//
// The split exists because the broadcast payload has to carry the persisted
// message id (reactions and replies target it), and an id only exists after
// the host's insert. Doing it in one step would force `reduce` to be `async`
// and perform I/O — losing the property that makes this package worth using.
//
// `null` return value means "ignore this action" — invalid payload, or a
// genuine no-op (e.g. pinning a message the host couldn't find, which
// deliberately leaves the current pin untouched).
//
// This file is the package's public surface and nothing else: every export
// below is re-exported from the module that implements it. Keep it that way —
// the modules are free to move code between themselves, but what a consumer
// can import is decided here, in one readable list.
//
//   types.ts     — wire and state shapes (types only)
//   sanitize.ts  — normalization of untrusted input, shared by both boundaries
//   state.ts     — defaultState
//   reduce.ts    — the action boundary, the effects it implies, and restore
//   extension.ts — the same thing packaged for @insession/space

export { type ChatExtensionOptions, chatExtension } from './extension.ts';
export { createChatState } from './reduce.ts';
export { isValidReactionEmoji } from './sanitize.ts';
export { defaultState } from './state.ts';
export type {
  ChatAction,
  ChatDraft,
  ChatEffect,
  ChatPayload,
  ChatPinnedMessage,
  ChatReactionCounts,
  ChatReduceResult,
  ChatReplySnapshot,
  ChatState,
  ChatStateApi,
  CreateChatStateOptions,
} from './types.ts';
