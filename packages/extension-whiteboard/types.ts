// The wire and state shapes of the Whiteboard state machine.
//
// Types only — no runtime code lives here, so every other module in this
// package can import from it without creating an initialization order between
// them.

/** Whether the board is a free-draw canvas or running the relay game. */
export type WhiteboardMode = 'free' | 'relay';

/** A phase of the "drawing telephone" relay game. */
export type RelayPhase = 'lobby' | 'prompt' | 'draw' | 'guess' | 'album';

export interface WhiteboardPoint {
  x: number;
  y: number;
}

export interface WhiteboardStrokePoint extends WhiteboardPoint {
  /** Optional pressure sample (0–1), when the input device reports it. */
  p?: number;
}

export interface WhiteboardStrokeStyle {
  fill: string;
  stroke: string;
  strokeWidth: number;
  opacity: number;
}

/** A confirmed freedraw stroke. */
export interface WhiteboardStroke {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  style: WhiteboardStrokeStyle;
  points: WhiteboardStrokePoint[];
  pen?: string;
  zIndex?: string;
  rotation?: number;
}

export type WhiteboardShapeType =
  | 'rectangle'
  | 'rounded-rect'
  | 'ellipse'
  | 'triangle'
  | 'diamond'
  | 'star'
  | 'arrow'
  | 'line'
  | 'connector'
  | 'text'
  | 'sticky';

export type AnchorType = 'auto' | 'top' | 'right' | 'bottom' | 'left' | 'custom';
export type PathType = 'straight' | 'elbow' | 'curve';
export type ArrowHead = 'none' | 'forward' | 'backward' | 'both';

export interface WhiteboardShapeStyle {
  fill: string;
  stroke: string;
  strokeWidth: number;
  opacity: number;
}

/**
 * A shape (rectangle/connector/text/sticky/...). Fields vary by `type`: geo
 * shapes (rectangle/rounded-rect/ellipse/triangle/diamond/star) get an
 * optional centered label, connectors get anchors/points/arrowheads,
 * text/sticky get their own required fields. This stays one interface with
 * the per-type fields optional rather than a discriminated union, mirroring
 * the wire shape produced by `sanitizeShape` (which itself branches on
 * `type` — see `applyShapeTypeFields`).
 */
export interface WhiteboardShape {
  id: string;
  type: WhiteboardShapeType;
  x: number;
  y: number;
  width: number;
  height: number;
  style: WhiteboardShapeStyle;
  rotation?: number;
  zIndex?: string;
  // Geo shapes (rectangle/rounded-rect/ellipse/triangle/diamond/star): optional centered label.
  text?: string;
  fontSize?: number;
  isEditing?: boolean;
  // rectangle only
  cornerRadius?: number;
  // connector only
  sourceId?: string;
  targetId?: string;
  sourceAnchor?: AnchorType;
  targetAnchor?: AnchorType;
  sourcePoint?: WhiteboardPoint;
  targetPoint?: WhiteboardPoint;
  controlPoint?: WhiteboardPoint;
  controlPointAuto?: boolean;
  arrowHead?: ArrowHead;
  pathType?: PathType;
  label?: string;
  // text only (in addition to the geo-label fields above)
  fontFamily?: string;
  // sticky only (in addition to the geo-label fields above)
  stickyColor?: string;
  color?: string;
}

/** One submission in a relay chain. */
export type RelayChainEntry =
  | { kind: 'prompt'; by: string; text: string }
  | { kind: 'drawing'; by: string; imageUrl: string | null }
  | { kind: 'guess'; by: string; text: string };

export interface RelayGame {
  phase: RelayPhase;
  round: number;
  totalRounds: number;
  players: string[];
  /** One chain per player, each a list of alternating prompt/drawing/guess entries. */
  chains: RelayChainEntry[][];
  /** Epoch ms when the current phase ends, or `null` in `lobby`/`album`. */
  endsAt: number | null;
  /** Display names that have submitted for the current round. */
  submitted: string[];
}

export interface WhiteboardState {
  strokes: WhiteboardStroke[];
  shapes: WhiteboardShape[];
  version: number;
  mode: WhiteboardMode;
  game: RelayGame | null;
}

export type WhiteboardAction =
  | 'add-stroke'
  | 'erase'
  | 'clear'
  | 'add-shape'
  | 'update-shape'
  | 'remove-shape'
  | 'set-mode'
  | 'join-game'
  | 'leave-game'
  | 'start-game'
  | 'reset-game'
  | 'submit-prompt'
  | 'submit-drawing'
  | 'submit-guess'
  /**
   * Forward a live drawing frame to everyone else. Changes nothing and is
   * never stored — see `relay` in the effects section.
   */
  | 'relay';

/**
 * Payload shapes for each action. Fields are loosely typed because `reduce`
 * treats the payload as untrusted wire data — every field is validated (and
 * safely ignored or rejected) at the point of use.
 */
export interface WhiteboardPayload {
  /** `add-stroke`: the stroke to add/replace. */
  stroke?: unknown;
  /** `erase`/`remove-shape`: ids to remove. */
  ids?: unknown;
  /** `add-shape`: the shape to add/replace. */
  shape?: unknown;
  /** `update-shape`: the id of the shape to patch. */
  id?: unknown;
  /** `update-shape`: the partial fields to apply. */
  patch?: unknown;
  /** `join-game`/`leave-game`/`submit-*`: the acting member's display name. */
  by?: unknown;
  /** `submit-prompt`/`submit-guess`: the text being submitted. */
  text?: unknown;
  /** `submit-drawing`: the uploaded drawing's URL. */
  imageUrl?: unknown;
  /**
   * Payload is untrusted wire data assembled by the host, so it may carry
   * fields beyond the ones named above — this keeps that assignable without
   * a cast.
   */
  [key: string]: unknown;
}

/**
 * A side effect for the host to run.
 *
 * A finished relay game is the one thing here worth keeping past the session:
 * the album is the payoff, and it disappears when the space empties.
 */
export type WhiteboardEffect =
  | {
      type: 'persist-relay-history';
      players: string[];
      chains: RelayChainEntry[][];
    }
  /**
   * Forward this frame to everyone but the sender. Nothing is stored.
   *
   * ⚠ `payload` is **opaque on purpose**. What a live frame contains — a
   * partial stroke, a whole board at reduced fidelity, a cursor position —
   * is a contract between a host's drawing client and its own renderer, and
   * it changes whenever that UI grows a feature. Teaching this package the
   * shape would drag UI churn into a package that is supposed to be stable,
   * so it passes through untouched and the host decides how it goes on the
   * wire.
   *
   * What this package *does* decide is that the whiteboard accepts relay at
   * all — an extension that never returns this effect simply cannot be
   * relayed through.
   */
  | { type: 'relay'; payload: unknown };

/**
 * What `reduce`/`onTimer` return when they accept an action.
 *
 * Without `state` it means "run these effects, nothing changed" — the live
 * relay case. `@insession/space` treats the two forms differently: the second
 * neither stores, broadcasts the board, nor re-arms the phase timer.
 */
export type WhiteboardReduceResult =
  | { state: WhiteboardState; effects: WhiteboardEffect[] }
  | { effects: WhiteboardEffect[] };

/**
 * The API returned by `createWhiteboardState`.
 */
export interface WhiteboardStateApi {
  defaultState: () => WhiteboardState;
  /**
   * Applies an action to the current state, returning the next state plus any
   * effects for the host to run, or `null` if the action is invalid/a no-op
   * and should be ignored entirely.
   *
   * `action` is typed as `string` rather than `WhiteboardAction` on purpose:
   * this function sits behind a wire boundary where the action name is
   * untrusted input, and any string outside the known set falls through to
   * `null`.
   */
  reduce: (
    state: WhiteboardState | null | undefined,
    action: string,
    payload?: WhiteboardPayload,
  ) => WhiteboardReduceResult | null;
  /**
   * Milliseconds until the next event (a relay phase expiring), or `null` if
   * there's nothing to wait for.
   */
  timerDelay: (state: WhiteboardState) => number | null;
  /**
   * Called when a relay phase expires: fills a placeholder entry for every
   * player who hasn't submitted, then advances the round.
   */
  onTimer: (state: WhiteboardState) => WhiteboardReduceResult | null;
  /**
   * Normalizes state loaded from storage into a safe shape. `null` only for
   * non-object input. `mode` always comes back `'free'` and `game` always
   * comes back `null` — a relay game in progress does not survive a server
   * restart (treated as abandoned, same as a decision made for playback
   * position elsewhere: come back to a safe stopped state, not a resumed one
   * built from a clock that's no longer valid).
   */
  restore: (raw: unknown) => WhiteboardState | null;
}
