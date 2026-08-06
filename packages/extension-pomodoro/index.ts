// Server-authoritative Pomodoro timer state machine.
//
// The state is owned by the server. While running, it carries `endsAt` (a
// wall-clock epoch ms) instead of a ticking counter, so clients render the
// countdown locally from `endsAt` and the server does not need to broadcast
// every second. Phase transitions are driven by the host application calling
// `onTimer()` after the delay returned by `timerDelay()` elapses.

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
   * with a `uid` are persisted (see `restore`/`persistState` below).
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

const MIN_MINUTES = 1;
const MAX_MINUTES = 120;

// A "one-line declaration" is not meant to hold long text.
const DECLARE_MAX_LEN = 80;
// Defensive caps applied when restoring from storage, so malformed or
// adversarial persisted data can't blow up memory (a space's member count
// never legitimately approaches these numbers).
const RESTORE_MAX_DECLARATIONS = 200;
const RESTORE_MAX_CHEERS = 200;

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
    // Declarations survive phase transitions, skip, and reset (see `reduce`
    // below) — they represent "what I'm doing this session", not per-phase
    // state. Only declarations with a `uid` get persisted; guest declarations
    // live only in this in-memory state.
    declarations: {},
    // Participation (join/leave) is keyed the same way as declarations (by
    // display name), but unlike declarations it is **session-only** and is
    // never restored from storage (see `restore`).
    participants: {},
  };
}

function phaseDuration(state: Pick<PomodoroState, 'config'>, phase: PomodoroPhase): number {
  return phase === 'work' ? state.config.work : state.config.break;
}

function clampMinutes(value: unknown, fallbackSeconds: number): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallbackSeconds;
  return Math.max(MIN_MINUTES, Math.min(MAX_MINUTES, n)) * 60;
}

// Normalizes declaration text (trim + clamp to DECLARE_MAX_LEN). Single
// source used by both `reduce` and `restore`.
function clampDeclarationText(value: unknown): string {
  return String(value ?? '')
    .trim()
    .slice(0, DECLARE_MAX_LEN);
}

// Advances to the next phase. `completed` (timer expired naturally) is the
// only case that counts toward `cycles`.
function advance(state: PomodoroState, completed: boolean): PomodoroState {
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

/**
 * Applies an action to the current state, returning the next state or
 * `null` if the action is invalid/a no-op and should be ignored.
 *
 * `action` is typed as `string` rather than `PomodoroAction` on purpose:
 * this function is meant to sit behind a wire boundary where the action
 * name is untrusted input, and any string outside the known set falls
 * through to `null` (see `default` below). Narrowing the parameter to
 * `PomodoroAction` would make that fallback unreachable from the type
 * system's point of view while giving callers no way to type-check
 * attacker/bug-controlled strings before calling in.
 *
 * Note on member-name payload fields (`by`, `target`): a non-string value is
 * rejected outright rather than coerced into a key. Coercion would let a
 * caller address a member through a value that merely stringifies to their
 * name, and it would allow non-strings to reach the `cheers: string[]` array,
 * breaking the type this module publishes. Hosts are expected to inject `by`
 * themselves from the authenticated member rather than trusting the wire.
 */
export function reduce(
  state: PomodoroState | null | undefined,
  action: string,
  payload?: PomodoroPayload,
): PomodoroState | null {
  const s = state || defaultState();
  switch (action as PomodoroAction) {
    case 'start':
      if (s.running) return null;
      return { ...s, running: true, endsAt: Date.now() + s.remaining * 1000 };
    case 'pause': {
      if (!s.running) return null;
      const remaining = Math.max(0, Math.round(((s.endsAt as number) - Date.now()) / 1000));
      return { ...s, running: false, endsAt: null, remaining };
    }
    case 'reset':
      // Declarations carry across sessions by requirement, so reset must not
      // fall back to defaultState()'s empty value — it's explicitly carried
      // over. Same reasoning for participants: reset re-initializes the
      // timer, it does not kick anyone out, so it must not be overwritten
      // with defaultState()'s empty value either.
      return {
        ...defaultState(),
        config: s.config,
        remaining: s.config.work,
        declarations: s.declarations,
        participants: s.participants,
      };
    case 'skip':
      return advance(s, false);
    case 'configure': {
      // Changing the phase length while running has ambiguous semantics, so
      // only stopped state accepts it.
      if (s.running) return null;
      const config: PomodoroConfig = {
        work: clampMinutes(payload?.workMinutes, s.config.work),
        break: clampMinutes(payload?.breakMinutes, s.config.break),
      };
      return { ...s, config, remaining: phaseDuration({ config }, s.phase) };
    }
    // One-line declaration, keyed by the sender's display name
    // (`payload.by`). Declaring an empty string clears it.
    case 'declare': {
      const by = payload?.by;
      if (!by || typeof by !== 'string') return null;
      const text = clampDeclarationText(payload?.text);
      const uid = typeof payload?.uid === 'string' ? payload.uid : null;
      // `Object.hasOwn` guard: `by` is wire-controlled, so a value like
      // `'constructor'` or `'toString'` must not resolve to an inherited
      // `Object.prototype` member instead of "no existing declaration".
      // Without this guard `s.declarations[by]` would return e.g.
      // `Object.prototype.constructor` (a function), and reading `.text`
      // off it below would either throw or silently misbehave. This bug
      // pre-dates the port (the source this package was ported from has the
      // same issue); it's fixed here rather than reproduced.
      const prev = Object.hasOwn(s.declarations, by) ? s.declarations[by] : undefined;
      if (!text) {
        if (!prev) return null; // already undeclared → no-op
        const declarations = { ...s.declarations };
        delete declarations[by];
        return { ...s, declarations };
      }
      if (prev && prev.text === text && prev.uid === uid) return null; // no-op
      // A text change makes existing cheers point at a different
      // declaration, so they're reset. If the text is unchanged (e.g. only
      // `uid` was attached), cheers are kept.
      const cheers = prev && prev.text === text ? prev.cheers : [];
      return { ...s, declarations: { ...s.declarations, [by]: { text, uid, cheers } } };
    }
    // Toggled cheer. Invalid when the target hasn't declared, or when
    // cheering your own declaration.
    case 'cheer': {
      const target = payload?.target;
      const by = payload?.by;
      if (!target || typeof target !== 'string' || !by || typeof by !== 'string' || target === by)
        return null;
      // See the `declare` case above for why this can't be a plain
      // `s.declarations[target]` lookup: `target` is wire-controlled and a
      // name like `'constructor'` would otherwise resolve to an inherited
      // `Object.prototype` value instead of "not declared".
      const decl = Object.hasOwn(s.declarations, target) ? s.declarations[target] : undefined;
      if (!decl) return null;
      const cheered = decl.cheers.includes(by);
      const cheers = cheered ? decl.cheers.filter((name) => name !== by) : [...decl.cheers, by];
      return { ...s, declarations: { ...s.declarations, [target]: { ...decl, cheers } } };
    }
    // Per-person "I'm in this session" signal. Has no bearing on who may
    // start/pause/skip/reset/configure the shared timer.
    case 'join': {
      const by = payload?.by;
      if (!by || typeof by !== 'string') return null;
      const uid = typeof payload?.uid === 'string' ? payload.uid : null;
      // Same `Object.hasOwn` guard as `declare`/`cheer`: `by` is
      // wire-controlled, so it must not be able to resolve to an inherited
      // `Object.prototype` member.
      const prev = Object.hasOwn(s.participants, by) ? s.participants[by] : undefined;
      if (prev && prev.uid === uid) return null; // no-op
      return { ...s, participants: { ...s.participants, [by]: { uid } } };
    }
    // Explicit leave (a client leaving the space entirely is handled by the
    // host application separately, outside this pure reducer).
    case 'leave': {
      const by = payload?.by;
      if (!by || typeof by !== 'string') return null;
      // Same `Object.hasOwn` guard as `declare`/`cheer`/`join` above.
      if (!Object.hasOwn(s.participants, by)) return null; // wasn't participating → no-op
      const participants = { ...s.participants };
      delete participants[by];
      return { ...s, participants };
    }
    default:
      return null;
  }
}

/**
 * Milliseconds until the next event (phase expiry) while running, or `null`
 * if there's nothing to wait for.
 */
export function timerDelay(state: PomodoroState): number | null {
  if (!state.running || !state.endsAt) return null;
  return Math.max(0, state.endsAt - Date.now());
}

/** Called when a phase expires: advances to the next phase, keeps running. */
export function onTimer(state: PomodoroState): PomodoroState {
  return advance(state, true);
}

// Normalizes declarations loaded from storage into a safe shape. Handles
// malformed/unexpected input defensively, with caps on both the number of
// declarations and the number of cheers per declaration.
function sanitizeDeclarations(raw: unknown): Record<string, PomodoroDeclaration> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, PomodoroDeclaration> = {};
  const names = Object.keys(raw).slice(0, RESTORE_MAX_DECLARATIONS);
  const rawRecord = raw as Record<string, unknown>;
  for (const name of names) {
    const d = rawRecord[name];
    if (!d || typeof d !== 'object') continue;
    const dRecord = d as Record<string, unknown>;
    const text = clampDeclarationText(dRecord.text);
    if (!text) continue; // empty text means "undeclared", so it isn't kept
    // Guest (no uid) declarations are not persisted by requirement: they're
    // dropped here when restoring from storage. A guest's declaration made
    // during the current session only lives in the in-memory state (see
    // `reduce`/host persistence hook); `restore` is the path used on server
    // restart or a reload from storage, so uid-less entries are treated as
    // "should never have reached storage" and discarded.
    if (typeof dRecord.uid !== 'string') continue;
    const uid = dRecord.uid;
    const cheersRaw = Array.isArray(dRecord.cheers) ? dRecord.cheers : [];
    const cheers = [...new Set(cheersRaw.filter((n): n is string => typeof n === 'string'))].slice(
      0,
      RESTORE_MAX_CHEERS,
    );
    // Defined rather than assigned: `name` comes from storage, and a plain
    // `out[name] = ...` with the name `'__proto__'` would invoke the setter
    // and replace this object's prototype with stored data instead of adding
    // a key. The declaration would vanish, and `for...in` over the result
    // would start yielding `text`/`uid`/`cheers` from the swapped prototype.
    // `defineProperty` always creates an own property, so a member whose
    // display name happens to be `'__proto__'` round-trips like any other.
    Object.defineProperty(out, name, {
      value: { text, uid, cheers },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/**
 * Strips volatile state before writing to storage. `participants` is
 * session-only: `restore` already drops it on the read side, but if only the
 * read side dropped it, the display names and uids would keep getting
 * written to storage (unread, but still retained). Dropping it on the write
 * side too means it never lands there in the first place.
 */
export function persistState(state: PomodoroState): PomodoroState {
  if (!state?.participants || Object.keys(state.participants).length === 0) return state;
  return { ...state, participants: {} };
}

/**
 * Normalizes state loaded from storage into a safe shape. Like a saved
 * playback position, it always comes back stopped rather than resuming a
 * countdown against a clock that's no longer valid.
 */
export function restore(raw: unknown): PomodoroState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const d = defaultState();
  const rawConfig = (r.config ?? {}) as Record<string, unknown>;
  const config: PomodoroConfig = {
    work: clampMinutes((Number(rawConfig.work) || d.config.work) / 60, d.config.work),
    break: clampMinutes((Number(rawConfig.break) || d.config.break) / 60, d.config.break),
  };
  const phase: PomodoroPhase = r.phase === 'break' ? 'break' : 'work';
  const duration = phase === 'work' ? config.work : config.break;
  const remaining = Math.trunc(Number(r.remaining));
  const cycles = Math.trunc(Number(r.cycles));
  return {
    running: false,
    phase,
    endsAt: null,
    remaining: Number.isFinite(remaining) ? Math.max(0, Math.min(duration, remaining)) : duration,
    config,
    cycles: Number.isFinite(cycles) ? Math.max(0, cycles) : 0,
    declarations: sanitizeDeclarations(r.declarations),
    // `participants` represents "who is in this session right now" — a
    // volatile signal — so restored state never uses the value from storage
    // and always comes back empty. Right after a restart, nobody has
    // rejoined yet (clients re-send `join` on reconnect).
    participants: {},
  };
}

// ── As a space extension ───────────────────────────────────────────────────

/** Options for `pomodoroExtension`. */
export interface PomodoroExtensionOptions {
  /**
   * The key this extension occupies in space state, and the identifier its
   * updates are broadcast under. Defaults to `'pomodoro'`.
   *
   * Overridable so a host can run two independent timers side by side, or fit
   * an existing wire protocol whose identifier differs.
   */
  name?: string;
}

/**
 * This module packaged as a space extension, ready to hand to
 * `createSpace({ extensions: [...] })` from `@insession/space`.
 *
 * Nothing is imported to build it: the returned object satisfies that
 * package's `SpaceExtension` *structurally*, so this package keeps its zero
 * dependencies and stays perfectly usable without `@insession/space` at all.
 * The individual functions remain exported for hosts that drive them directly.
 */
export function pomodoroExtension(options: PomodoroExtensionOptions = {}) {
  return {
    name: options.name ?? 'pomodoro',
    server: { defaultState, reduce, timerDelay, onTimer, restore, persistState },
  };
}
