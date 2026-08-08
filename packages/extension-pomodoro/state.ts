// The state shape itself: its default value and the transitions that are
// phrased in terms of the clock rather than of an action.

import type { PomodoroPhase, PomodoroState } from './types.ts';

/**
 * The default state for a space that doesn't have Pomodoro state yet.
 * Exported so hosts can use it as a fallback before any `app-action` has
 * been reduced.
 */
export function defaultState(): PomodoroState {
  return {
    running: false,
    phase: 'work',
    endsAt: null,
    remaining: 25 * 60,
    config: { work: 25 * 60, break: 5 * 60 },
    cycles: 0,
    // Declarations survive phase transitions, skip, and reset (see `reduce`)
    // — they represent "what I'm doing this session", not per-phase state.
    // Only declarations with a `uid` get persisted; guest declarations live
    // only in this in-memory state.
    declarations: {},
    // Participation (join/leave) is keyed the same way as declarations (by
    // display name), but unlike declarations it is **session-only** and is
    // never restored from storage (see `restore`).
    participants: {},
  };
}

export function phaseDuration(state: Pick<PomodoroState, 'config'>, phase: PomodoroPhase): number {
  return phase === 'work' ? state.config.work : state.config.break;
}

// Advances to the next phase. `completed` (timer expired naturally) is the
// only case that counts toward `cycles`.
export function advance(state: PomodoroState, completed: boolean): PomodoroState {
  const phase: PomodoroPhase = state.phase === 'work' ? 'break' : 'work';
  const duration = phaseDuration(state, phase);
  return {
    ...state,
    phase,
    cycles: state.cycles + (completed && state.phase === 'work' ? 1 : 0),
    endsAt: state.running ? Date.now() + duration * 1000 : null,
    remaining: duration,
  };
}
