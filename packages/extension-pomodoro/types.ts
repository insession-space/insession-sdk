// The wire and state shapes of the Pomodoro state machine.
//
// Types only — no runtime code lives here, so every other module in this
// package can import from it without creating an initialization order between
// them.

/** A timer phase: focused work, or a break between work phases. */
export type PomodoroPhase = 'work' | 'break';

/** Length of each phase, in seconds. */
export interface PomodoroConfig {
  work: number;
  break: number;
}

/** A one-line declaration ("what I'm doing this session") with toggled cheers. */
export interface PomodoroDeclaration {
  text: string;
  /**
   * The declarer's stable user id, or `null` for a guest. Only declarations
   * with a `uid` are persisted (see `restore`/`persistState`).
   */
  uid: string | null;
  /** Names of the people who cheered this declaration. */
  cheers: string[];
}

/**
 * A participant's membership in the current Pomodoro session. This is a
 * session-only signal — it does not affect who may start/pause/skip/configure
 * the shared timer, and it is never persisted (see `persistState`/`restore`).
 */
export interface PomodoroParticipant {
  uid: string | null;
}

export interface PomodoroState {
  running: boolean;
  phase: PomodoroPhase;
  /** Epoch ms when the current phase ends. Only set while `running`. */
  endsAt: number | null;
  /** Remaining seconds in the current phase while stopped. */
  remaining: number;
  config: PomodoroConfig;
  /** Number of completed work phases. */
  cycles: number;
  /** Declarations keyed by member display name. */
  declarations: Record<string, PomodoroDeclaration>;
  /** Session participants keyed by member display name. */
  participants: Record<string, PomodoroParticipant>;
}

export type PomodoroAction =
  | 'start'
  | 'pause'
  | 'reset'
  | 'skip'
  | 'configure'
  | 'declare'
  | 'cheer'
  | 'join'
  | 'leave';

/**
 * Payload shapes for each action. Fields are optional/loosely typed because
 * `reduce` treats the payload as untrusted wire data — every field is
 * validated (and safely ignored or rejected) at the point of use.
 */
export interface PomodoroPayload {
  /** `configure`: desired work-phase length in minutes (clamped, non-integer safe). */
  workMinutes?: unknown;
  /** `configure`: desired break-phase length in minutes (clamped, non-integer safe). */
  breakMinutes?: unknown;
  /** `declare`/`join`/`leave`: the acting member's display name. */
  by?: unknown;
  /** `declare`: the declaration text (trimmed and length-clamped). */
  text?: unknown;
  /** `declare`/`join`: the acting member's stable user id, if signed in. */
  uid?: unknown;
  /** `cheer`: the display name of the declaration being cheered. */
  target?: unknown;
  /**
   * Payload is untrusted wire data assembled by the host (typically
   * `{ ...wirePayload, by: memberName, uid: client.uid }`), so it may carry
   * fields beyond the ones named above — this keeps that assignable without
   * a cast.
   */
  [key: string]: unknown;
}

/**
 * A side effect for the host to run.
 *
 * Declarations are the one thing here that outlives a session: a member's
 * one-liner is meant to come back when they rejoin, so it belongs in the
 * host's storage keyed by member and space. Which member changed, and to
 * what, is something only the transition knows — so `reduce` says it, and the
 * host performs the write.
 *
 * Only *signed-in* members produce effects. A guest's declaration lives in
 * state and nowhere else, by design.
 */
export type PomodoroEffect =
  /** Store (or overwrite) this member's declaration text. */
  | { type: 'persist-declaration'; uid: string; text: string }
  /** The member cleared their declaration; remove the stored one. */
  | { type: 'delete-declaration'; uid: string };

/** What `reduce`/`onTimer` return when they accept an action. */
export interface PomodoroReduceResult {
  state: PomodoroState;
  effects: PomodoroEffect[];
}
