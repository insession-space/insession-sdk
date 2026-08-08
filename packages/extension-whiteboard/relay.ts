// The "drawing telephone" relay game.
//
// A self-contained sub-domain: everything here is phrased in terms of
// `RelayGame` alone and knows nothing about strokes, shapes, or the board it
// runs on top of. The rules that decide how many rounds a group plays, which
// chain a player is on, and when a phase ends live here so the whiteboard
// reducer only has to say *when* they apply.

import type { RelayChainEntry, RelayGame, RelayPhase } from './types.ts';

// Relay game caps/phase durations.
export const MAX_PLAYERS = 8;
export const PROMPT_MS = 60_000;
const DRAW_MS = 90_000;
const GUESS_MS = 45_000;
// Clients auto-submit their in-progress prompt/drawing/guess the instant
// their local countdown hits zero. `timerDelay` (how long the host waits
// before calling `onTimer`) adds this grace period so a fast-but-not-instant
// auto-submit reaches the server *before* `onTimer`'s "fill placeholders for
// whoever hasn't submitted" pass runs — otherwise the placeholder could win
// the race and silently overwrite a submission that was already on its way.
// `submitToChain` ignores players who've already submitted, so when the
// auto-submit does arrive in time, `onTimer` simply skips that player (same
// "only fill the missing ones" behavior as always).
export const TIMEOUT_GRACE_MS = 5_000;

// An empty lobby (no game started yet), used to lazily create `game`.
export function emptyLobby(): RelayGame {
  return {
    phase: 'lobby',
    round: 0,
    totalRounds: 0,
    players: [],
    chains: [],
    endsAt: null,
    submitted: [],
  };
}

// Which chain index player `i` is responsible for on round `r` (0-based),
// out of `n` players. The ring of chains rotates by one player per round.
function chainIndexFor(i: number, r: number, n: number): number {
  return (((i - r) % n) + n) % n;
}

// Total round count. Must always start with a prompt and end with a guess
// (i.e. an odd number of rounds), or the final drawing in the chain would
// never get guessed.
//
// For an even player count, using the player count as-is would end on a
// `draw` round. The fix is to *subtract* one rather than add one: adding
// (n+1) would make each player's chain wrap all the way back to their own
// starting prompt as the final guess (they'd recognize their own prompt and
// it wouldn't be a real guess). Subtracting one means no player ever revisits
// their own chain. The one exception is 2 players, who need 3 rounds — with
// only 2 chains, that overlap is unavoidable and accepted.
export function totalRoundsFor(playerCount: number): number {
  if (playerCount === 2) return 3;
  return playerCount % 2 === 0 ? playerCount - 1 : playerCount;
}

// Derives the current phase from round/totalRounds: round 0 is `prompt`,
// odd rounds after that are `draw`, even rounds are `guess`, and reaching
// `totalRounds` means the game is over (`album`).
function phaseForRound(round: number, totalRounds: number): RelayPhase {
  if (round >= totalRounds) return 'album';
  if (round === 0) return 'prompt';
  return round % 2 === 1 ? 'draw' : 'guess';
}

function durationForPhase(phase: RelayPhase): number | null {
  if (phase === 'prompt') return PROMPT_MS;
  if (phase === 'draw') return DRAW_MS;
  if (phase === 'guess') return GUESS_MS;
  return null;
}

// Advances to the next round. Pure — returns a new `game` rather than
// mutating. Called from both "everyone submitted" and "timer expired" paths.
function advanceRound(game: RelayGame): RelayGame {
  const round = game.round + 1;
  const phase = phaseForRound(round, game.totalRounds);
  const duration = durationForPhase(phase);
  const endsAt = phase === 'album' || duration == null ? null : Date.now() + duration;
  return { ...game, round, phase, endsAt, submitted: [] };
}

// Appends `entry` to the current round's chain for `by`. `null` if `by` is
// missing, already submitted, or not a player.
export function submitToChain(
  game: RelayGame,
  by: string | null,
  entry: RelayChainEntry,
): RelayGame | null {
  if (!by) return null;
  if (game.submitted.includes(by)) return null;
  const i = game.players.indexOf(by);
  if (i === -1) return null;
  const chainIdx = chainIndexFor(i, game.round, game.players.length);
  const chains = game.chains.map((c, idx) => (idx === chainIdx ? [...c, entry] : c));
  const submitted = [...game.submitted, by];
  const next = { ...game, chains, submitted };
  // Once everyone has submitted, advance immediately rather than waiting for
  // the timer.
  return submitted.length >= next.players.length ? advanceRound(next) : next;
}

/**
 * What a phase expiring does: every player who hasn't submitted gets a
 * placeholder entry on their chain, then the round advances.
 *
 * The placeholder is written directly rather than via `submitToChain`,
 * because that helper advances the round as soon as the last player is
 * accounted for — going through it would advance mid-loop and put the
 * remaining placeholders on the wrong round.
 */
export function fillMissingAndAdvance(game: RelayGame): RelayGame {
  const phase = game.phase;
  let g = game;
  for (const by of game.players) {
    if (g.submitted.includes(by)) continue;
    const entry: RelayChainEntry =
      phase === 'draw'
        ? { kind: 'drawing', by, imageUrl: null }
        : { kind: phase === 'prompt' ? 'prompt' : 'guess', by, text: '' };
    const i = g.players.indexOf(by);
    const chainIdx = chainIndexFor(i, g.round, g.players.length);
    const chains = g.chains.map((c, idx) => (idx === chainIdx ? [...c, entry] : c));
    g = { ...g, chains, submitted: [...g.submitted, by] };
  }
  return advanceRound(g);
}
