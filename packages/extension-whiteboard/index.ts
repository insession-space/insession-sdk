// Server-authoritative Whiteboard state machine: a shared free-draw canvas
// (confirmed strokes + shapes) plus an optional "drawing telephone" relay
// game (mode 'relay') that can run alongside it.
//
// Sync model: only *confirmed* strokes (pointer released) and shapes belong
// in this state — they get validated, folded into `state`, persisted, and
// broadcast to everyone (including late joiners via `restore`). In-progress
// strokes (live preview while someone is still drawing) are deliberately
// **not** this module's concern: a host relays those out-of-band (fire and
// forget, no validation, no persistence) so every pointer move doesn't have
// to round-trip through `reduce`.
//
// Strokes are freedraw shapes compatible with a generic `{ id, type, x, y,
// width, height, style, points }` shape format; this module doesn't depend
// on any particular drawing engine, it only normalizes and caps the fields
// it needs to keep state small and safe to store.
//
// `createWhiteboardState` returns the full API (`defaultState` / `reduce` /
// `timerDelay` / `onTimer` / `restore`) as a bundle so callers don't need to
// remember which export came from where. `defaultState` doesn't depend on
// the factory's arguments, so it's also available as a top-level named
// export for callers who only need a fallback/initial value and don't want
// to construct the whole API just for that.
//
// This file is the package's public surface and nothing else: every export
// below is re-exported from the module that implements it. Keep it that way —
// the modules are free to move code between themselves, but what a consumer
// can import is decided here, in one readable list.
//
//   types.ts     — wire and state shapes (types only)
//   sanitize.ts  — normalization and caps, shared by both boundaries
//   relay.ts     — the "drawing telephone" game rules, in terms of RelayGame alone
//   state.ts     — defaultState
//   reduce.ts    — the action boundary, its effects, and restore
//   extension.ts — the same thing packaged for @insession/space

export { type WhiteboardExtensionOptions, whiteboardExtension } from './extension.ts';
export { createWhiteboardState } from './reduce.ts';
export { defaultState } from './state.ts';
export type {
  AnchorType,
  ArrowHead,
  PathType,
  RelayChainEntry,
  RelayGame,
  RelayPhase,
  WhiteboardAction,
  WhiteboardEffect,
  WhiteboardMode,
  WhiteboardPayload,
  WhiteboardPoint,
  WhiteboardReduceResult,
  WhiteboardShape,
  WhiteboardShapeStyle,
  WhiteboardShapeType,
  WhiteboardState,
  WhiteboardStateApi,
  WhiteboardStroke,
  WhiteboardStrokePoint,
  WhiteboardStrokeStyle,
} from './types.ts';
