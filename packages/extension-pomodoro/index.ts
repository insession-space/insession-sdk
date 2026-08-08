// Server-authoritative Pomodoro timer state machine.
//
// The state is owned by the server. While running, it carries `endsAt` (a
// wall-clock epoch ms) instead of a ticking counter, so clients render the
// countdown locally from `endsAt` and the server does not need to broadcast
// every second. Phase transitions are driven by the host application calling
// `onTimer()` after the delay returned by `timerDelay()` elapses.
//
// This file is the package's public surface and nothing else: every export
// below is re-exported from the module that implements it. Keep it that way —
// the modules are free to move code between themselves, but what a consumer
// can import is decided here, in one readable list.
//
//   types.ts     — wire and state shapes (types only)
//   sanitize.ts  — clamping shared by the wire and storage boundaries
//   state.ts     — defaultState and the clock-driven transitions
//   reduce.ts    — the action boundary, plus the effects a transition implies
//   persist.ts   — the storage boundary (persistState / restore)
//   extension.ts — the same thing packaged for @insession/space

export { type PomodoroExtensionOptions, pomodoroExtension } from './extension.ts';
export { persistState, restore } from './persist.ts';
export { onTimer, reduce, timerDelay } from './reduce.ts';
export { defaultState } from './state.ts';
export type {
  PomodoroAction,
  PomodoroConfig,
  PomodoroDeclaration,
  PomodoroEffect,
  PomodoroParticipant,
  PomodoroPayload,
  PomodoroPhase,
  PomodoroReduceResult,
  PomodoroState,
} from './types.ts';
