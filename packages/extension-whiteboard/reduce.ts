// The action boundary: what an incoming action does to the board, which
// effects the host has to run, and how state comes back from storage.

import {
  emptyLobby,
  fillMissingAndAdvance,
  MAX_PLAYERS,
  PROMPT_MS,
  submitToChain,
  TIMEOUT_GRACE_MS,
  totalRoundsFor,
} from './relay.ts';
import {
  clampNum,
  MAX_SHAPES,
  MAX_STROKES,
  sanitizeName,
  sanitizeShape,
  sanitizeShapePatch,
  sanitizeStroke,
  sanitizeText,
  str,
  withinShapeByteCap,
} from './sanitize.ts';
import { defaultState } from './state.ts';
import type {
  WhiteboardAction,
  WhiteboardEffect,
  WhiteboardPayload,
  WhiteboardReduceResult,
  WhiteboardShape,
  WhiteboardState,
  WhiteboardStateApi,
  WhiteboardStroke,
} from './types.ts';

/**
 * Builds the Whiteboard state API. The one place this module touches
 * anything outside itself is validating a submitted drawing's image URL
 * (the `submit-drawing` action) — accepting an arbitrary URL there would let
 * a client point the board at any external image, so only URLs the host
 * recognizes as its own storage are accepted. Since "is this my storage's
 * URL" is inherently host-specific (bucket, domain, signing scheme, ...),
 * it can't be baked into this package — the host supplies it as
 * `isOwnImageUrl`.
 *
 * `isOwnImageUrl` is **required**, not optional-with-a-default. A default of
 * "accept everything" would mean a host that forgets to pass it silently
 * accepts arbitrary external URLs into shared state — a security hole that
 * fails open exactly when it's easiest to miss (no error, no warning, it
 * just works until someone embeds something malicious). A missing/non-function
 * value throws immediately instead.
 *
 * All five members of the returned API are constructed here, even the ones
 * that don't actually read `isOwnImageUrl` (`defaultState`/`timerDelay`/
 * `onTimer`/`restore`), so callers don't have to remember which export came
 * from the factory and which didn't. `defaultState` is additionally
 * available as a top-level named export (see its own doc comment) since it's
 * the one member that's obviously argument-independent even to a reader who
 * hasn't seen this function's body.
 */
export function createWhiteboardState(options: {
  /**
   * Predicate for whether an image URL may be accepted into state. Return
   * `true` only for URLs the host recognizes as its own storage (e.g. its R2
   * bucket's public URL prefix) — everything else gets rejected, dropping
   * the `submit-drawing` action.
   */
  isOwnImageUrl: (url: string) => boolean;
}): WhiteboardStateApi {
  if (!options || typeof options.isOwnImageUrl !== 'function') {
    throw new TypeError(
      'createWhiteboardState: options.isOwnImageUrl is required (a predicate that returns true only for URLs the host recognizes as its own storage)',
    );
  }
  const { isOwnImageUrl } = options;

  // Submitted drawing URL. Only the host's own storage URLs are accepted, to
  // prevent arbitrary external URLs from being embedded into shared state.
  function sanitizeImageUrl(v: unknown): string | null {
    return typeof v === 'string' && isOwnImageUrl(v) ? v : null;
  }

  function reduceState(
    state: WhiteboardState | null | undefined,
    action: string,
    payload?: WhiteboardPayload,
  ): WhiteboardState | null {
    const s = state || defaultState();
    switch (action as WhiteboardAction) {
      case 'add-stroke': {
        const stroke = sanitizeStroke(payload?.stroke);
        if (!stroke) return null;
        // Same id replaces (prevents duplicate adds); otherwise appended.
        const rest = s.strokes.filter((x) => x.id !== stroke.id);
        let strokes = [...rest, stroke];
        if (strokes.length > MAX_STROKES) strokes = strokes.slice(strokes.length - MAX_STROKES);
        return { ...s, strokes, version: s.version + 1 };
      }
      case 'erase': {
        const ids = Array.isArray(payload?.ids) ? payload.ids.map((x) => str(x)) : [];
        if (ids.length === 0) return null;
        const idSet = new Set(ids);
        const strokes = s.strokes.filter((x) => !idSet.has(x.id));
        if (strokes.length === s.strokes.length) return null; // Nothing erased → no-op.
        return { ...s, strokes, version: s.version + 1 };
      }
      case 'clear': {
        // "Clear the board" empties both strokes and shapes, so both are
        // cleared together here — keeping shapes around after a clear would
        // silently break that meaning.
        if (s.strokes.length === 0 && s.shapes.length === 0) return null;
        return { ...s, strokes: [], shapes: [], version: s.version + 1 };
      }
      case 'add-shape': {
        const shape = sanitizeShape(payload?.shape);
        if (!shape) return null;
        const existing = s.shapes.find((x) => x.id === shape.id);
        // Symmetric with `update-shape` not allowing a type change: replacing
        // an existing id is only allowed when the type matches, otherwise a
        // reused id could smuggle through what amounts to a type change.
        if (existing && existing.type !== shape.type) return null;
        if (!existing && s.shapes.length >= MAX_SHAPES) return null; // Cap only applies to genuinely new shapes.
        // Same id (and same type) replaces; otherwise appended.
        const shapes = existing
          ? s.shapes.map((x) => (x.id === shape.id ? shape : x))
          : [...s.shapes, shape];
        return { ...s, shapes, version: s.version + 1 };
      }
      case 'update-shape': {
        const id = str(payload?.id);
        if (!id) return null;
        const existing = s.shapes.find((x) => x.id === id);
        if (!existing) return null;
        const patch = sanitizeShapePatch(existing.type, payload?.patch);
        if (!patch) return null;
        // `style` needs its own merge step: a top-level shallow merge would
        // otherwise replace the whole style object and drop any fields the
        // patch didn't mention.
        if (patch.style) {
          patch.style = { ...existing.style, ...(patch.style as Record<string, unknown>) };
        }
        const next = { ...existing, ...patch } as WhiteboardShape;
        if (!withinShapeByteCap(next)) return null;
        const shapes = s.shapes.map((x) => (x.id === id ? next : x));
        return { ...s, shapes, version: s.version + 1 };
      }
      case 'remove-shape': {
        // Capped to MAX_SHAPES entries before processing so an unbounded
        // array can't burn CPU (there are never more than MAX_SHAPES shapes
        // to begin with, so anything past that is meaningless).
        const ids = Array.isArray(payload?.ids)
          ? payload.ids.slice(0, MAX_SHAPES).map((x) => str(x))
          : [];
        if (ids.length === 0) return null;
        const idSet = new Set(ids);
        const shapes = s.shapes.filter((x) => !idSet.has(x.id));
        if (shapes.length === s.shapes.length) return null; // Nothing removed → no-op.
        return { ...s, shapes, version: s.version + 1 };
      }
      case 'set-mode': {
        // Older clients may still send this action even though tab
        // switching has since moved client-side. Accepting it and setting
        // `game: null` would let anyone silently discard an in-progress
        // relay game (its players and each chain's progress) from what looks
        // like a harmless display toggle. The action name is still accepted
        // for backward compatibility, but it's always a no-op — `state.mode`
        // itself is left as a display-only remnant.
        return null;
      }
      case 'join-game': {
        // `state.mode` is display-only at this point; whether the game can
        // be joined/started is decided purely by `game`'s presence/phase.
        const by = sanitizeName(payload?.by);
        if (!by) return null;
        // No game yet (`null`) is treated as an empty lobby, lazily created
        // the moment someone first joins.
        const game = s.game || emptyLobby();
        if (game.phase !== 'lobby') return null;
        if (game.players.includes(by)) return null;
        if (game.players.length >= MAX_PLAYERS) return null;
        return { ...s, game: { ...game, players: [...game.players, by] } };
      }
      case 'leave-game': {
        const by = sanitizeName(payload?.by);
        if (!by) return null;
        const game = s.game;
        if (!game || game.phase !== 'lobby') return null;
        if (!game.players.includes(by)) return null;
        return { ...s, game: { ...game, players: game.players.filter((p) => p !== by) } };
      }
      case 'start-game': {
        const game = s.game;
        if (!game || game.phase !== 'lobby') return null;
        if (game.players.length < 2) return null;
        const totalRounds = totalRoundsFor(game.players.length);
        return {
          ...s,
          game: {
            phase: 'prompt',
            round: 0,
            totalRounds,
            players: game.players,
            chains: game.players.map(() => []),
            endsAt: Date.now() + PROMPT_MS,
            submitted: [],
          },
        };
      }
      case 'reset-game': {
        // Closes the album and returns to the lobby (rematch). Players carry
        // over so the group doesn't have to rejoin to start again.
        const game = s.game;
        if (!game || game.phase !== 'album') return null;
        return { ...s, game: { ...emptyLobby(), players: game.players } };
      }
      case 'submit-prompt': {
        const game = s.game;
        if (!game || game.phase !== 'prompt') return null;
        const text = sanitizeText(payload?.text);
        if (text == null) return null;
        const by = sanitizeName(payload?.by);
        const nextGame = submitToChain(game, by, { kind: 'prompt', by: by as string, text });
        if (!nextGame) return null;
        return { ...s, game: nextGame };
      }
      case 'submit-drawing': {
        const game = s.game;
        if (!game || game.phase !== 'draw') return null;
        const imageUrl = sanitizeImageUrl(payload?.imageUrl);
        if (imageUrl == null) return null;
        const by = sanitizeName(payload?.by);
        const nextGame = submitToChain(game, by, { kind: 'drawing', by: by as string, imageUrl });
        if (!nextGame) return null;
        return { ...s, game: nextGame };
      }
      case 'submit-guess': {
        const game = s.game;
        if (!game || game.phase !== 'guess') return null;
        const text = sanitizeText(payload?.text);
        if (text == null) return null;
        const by = sanitizeName(payload?.by);
        const nextGame = submitToChain(game, by, { kind: 'guess', by: by as string, text });
        if (!nextGame) return null;
        return { ...s, game: nextGame };
      }
      default:
        return null;
    }
  }

  function timerDelay(state: WhiteboardState): number | null {
    const endsAt = state?.game?.endsAt;
    if (!endsAt) return null;
    return Math.max(0, endsAt + TIMEOUT_GRACE_MS - Date.now());
  }

  function advanceOnTimer(state: WhiteboardState): WhiteboardState | null {
    const game = state.game;
    if (!game) return null;
    return { ...state, game: fillMissingAndAdvance(game) };
  }

  function restore(raw: unknown): WhiteboardState | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const strokesArr = Array.isArray(r.strokes) ? r.strokes : [];
    const strokes = strokesArr
      .map(sanitizeStroke)
      .filter((x): x is WhiteboardStroke => x !== null)
      .slice(0, MAX_STROKES);
    const shapesArr = Array.isArray(r.shapes) ? r.shapes : [];
    const shapes = shapesArr
      .map(sanitizeShape)
      .filter((x): x is WhiteboardShape => x !== null)
      .slice(0, MAX_SHAPES);
    const version = Math.max(0, Math.trunc(clampNum(r.version)));
    // `game` is dropped on restore: a relay game in progress is a live,
    // time-boxed activity (players mid-round, phase timers running), and
    // there's no sound way to resume a countdown against a clock that's no
    // longer valid after a restart. It's treated as abandoned, the same
    // choice `restore` implementations elsewhere in this SDK make for
    // playback position and running timers.
    return { strokes, shapes, version, mode: 'free', game: null };
  }

  // A finished relay is the one thing here worth keeping past the session:
  // the album (who drew what, in which order) is the payoff, and it is gone
  // the moment the space empties. Only the transition knows the round just
  // ended, so it says so and the host performs the write.
  //
  // Fired exactly once per game, on the edge into `album` — `reset-game`
  // returns to the lobby, so a rematch produces its own single effect.
  function relayFinishedEffects(prev: WhiteboardState, next: WhiteboardState): WhiteboardEffect[] {
    const game = next.game;
    if (!game || game.phase !== 'album') return [];
    if (prev.game?.phase === 'album') return [];
    return [{ type: 'persist-relay-history', players: game.players, chains: game.chains }];
  }

  function reduce(
    state: WhiteboardState | null | undefined,
    action: string,
    payload?: WhiteboardPayload,
  ): WhiteboardReduceResult | null {
    // ⚠ Handled before the state machine, and returning effects *without* a
    // state, because a live frame changes nothing. Going through the normal
    // path would persist it, broadcast the board, and re-arm the relay phase
    // timer on every pointer move — the last of which would keep a countdown
    // that is supposed to run out from ever running out.
    if (action === 'relay') {
      return { effects: [{ type: 'relay', payload: payload?.payload }] };
    }
    const prev = state || defaultState();
    const next = reduceState(state, action, payload);
    if (next === null) return null;
    return { state: next, effects: relayFinishedEffects(prev, next) };
  }

  function onTimer(state: WhiteboardState): WhiteboardReduceResult | null {
    const next = advanceOnTimer(state);
    if (next === null) return null;
    return { state: next, effects: relayFinishedEffects(state, next) };
  }

  return { defaultState, reduce, timerDelay, onTimer, restore };
}
