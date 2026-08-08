// The storage boundary: what gets written out, and how what comes back is
// made safe again. Both directions live together because they have to agree
// about which fields survive a restart — `participants` is dropped on each
// side, and the two drops are only obviously consistent when read side by
// side.

import { clampDeclarationText, clampMinutes } from './sanitize.ts';
import { defaultState } from './state.ts';
import type { PomodoroConfig, PomodoroDeclaration, PomodoroPhase, PomodoroState } from './types.ts';

// Defensive caps applied when restoring from storage, so malformed or
// adversarial persisted data can't blow up memory (a space's member count
// never legitimately approaches these numbers).
const RESTORE_MAX_DECLARATIONS = 200;
const RESTORE_MAX_CHEERS = 200;

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
