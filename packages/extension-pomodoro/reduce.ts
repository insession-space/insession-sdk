// The action boundary: what an incoming `app-action` does to the state, and
// what the host has to write to storage as a result.

import { clampDeclarationText, clampMinutes } from './sanitize.ts';
import { advance, defaultState, phaseDuration } from './state.ts';
import type {
  PomodoroAction,
  PomodoroConfig,
  PomodoroEffect,
  PomodoroPayload,
  PomodoroReduceResult,
  PomodoroState,
} from './types.ts';

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
function reduceState(
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
 * The declaration writes implied by a transition.
 *
 * Only `declare` can produce them: `cheer` touches `declarations` too, but
 * cheers are not stored, and every other action leaves declarations alone.
 * Comparing just the acting member's entry is enough for the same reason —
 * an action can only change their own.
 */
function declarationEffects(
  prev: PomodoroState,
  next: PomodoroState,
  action: string,
  payload?: PomodoroPayload,
): PomodoroEffect[] {
  if (action !== 'declare') return [];
  const by = typeof payload?.by === 'string' ? payload.by : null;
  if (!by) return [];
  const before = Object.hasOwn(prev.declarations, by) ? prev.declarations[by] : undefined;
  const after = Object.hasOwn(next.declarations, by) ? next.declarations[by] : undefined;
  if (after?.uid) {
    // Unchanged text with the same uid means nothing to store — the state
    // could still have changed (cheers reset), but storage would not.
    if (before && before.text === after.text && before.uid === after.uid) return [];
    return [{ type: 'persist-declaration', uid: after.uid, text: after.text }];
  }
  if (!after && before?.uid) return [{ type: 'delete-declaration', uid: before.uid }];
  return [];
}

/**
 * Applies an action, returning the next state plus any effects for the host
 * to run, or `null` if the action is invalid/a no-op.
 *
 * See `reduceState` above for why `action` is a `string` and why member-name
 * payload fields are rejected rather than coerced.
 */
export function reduce(
  state: PomodoroState | null | undefined,
  action: string,
  payload?: PomodoroPayload,
): PomodoroReduceResult | null {
  const prev = state || defaultState();
  const next = reduceState(state, action, payload);
  if (next === null) return null;
  return { state: next, effects: declarationEffects(prev, next, action, payload) };
}

/**
 * Milliseconds until the next event (phase expiry) while running, or `null`
 * if there's nothing to wait for.
 */
export function timerDelay(state: PomodoroState): number | null {
  if (!state.running || !state.endsAt) return null;
  return Math.max(0, state.endsAt - Date.now());
}

/**
 * Called when a phase expires: advances to the next phase, keeps running.
 * Phase changes never touch declarations, so the effect list is always empty —
 * it is returned anyway so both entry points have one shape.
 */
export function onTimer(state: PomodoroState): PomodoroReduceResult {
  return { state: advance(state, true), effects: [] };
}
