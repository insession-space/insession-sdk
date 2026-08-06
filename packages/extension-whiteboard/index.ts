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
  | 'submit-guess';

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

// Caps against state bloat and adversarial oversized payloads.
const MAX_STROKES = 2000; // Confirmed strokes per board. Oldest are dropped once exceeded.
const MAX_POINTS = 5000; // Points per stroke.
const MAX_STR = 64; // Length cap for id/type/pen-style string fields.

const MAX_SHAPES = 500; // Shapes per board. New additions are rejected once exceeded.
const MAX_SHAPE_TEXT = 500; // Length cap for text/label fields on shapes.
const MAX_SHAPE_BYTES = 8 * 1024; // Serialized-size cap per shape.

const SHAPE_TYPES = new Set<WhiteboardShapeType>([
  'rectangle',
  'rounded-rect',
  'ellipse',
  'triangle',
  'diamond',
  'star',
  'arrow',
  'line',
  'connector',
  'text',
  'sticky',
]);

// Geo shapes that may carry an optional centered label.
const GEO_LABEL_TYPES = new Set<WhiteboardShapeType>([
  'rectangle',
  'rounded-rect',
  'ellipse',
  'triangle',
  'diamond',
  'star',
]);

const ANCHOR_TYPES = new Set<AnchorType>(['auto', 'top', 'right', 'bottom', 'left', 'custom']);
const PATH_TYPES = new Set<PathType>(['straight', 'elbow', 'curve']);
const ARROW_HEADS = new Set<ArrowHead>(['none', 'forward', 'backward', 'both']);

// Relay game caps/phase durations.
const MAX_PLAYERS = 8;
const MAX_TEXT = 100; // Prompt/guess text length cap.
const PROMPT_MS = 60_000;
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
const TIMEOUT_GRACE_MS = 5_000;

/**
 * The default state for a board that doesn't have Whiteboard state yet.
 * Exported at the top level (unlike the rest of the API) because it doesn't
 * depend on `createWhiteboardState`'s `isOwnImageUrl` argument — callers who
 * only need a fallback/initial value don't need to construct the factory
 * just for this.
 */
export function defaultState(): WhiteboardState {
  return {
    strokes: [],
    shapes: [],
    version: 0,
    mode: 'free',
    game: null,
  };
}

// An empty lobby (no game started yet), used to lazily create `game`.
function emptyLobby(): RelayGame {
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

function clampNum(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(v: unknown, max = MAX_STR): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

// Normalizes one freedraw stroke into a safe shape, or `null` if invalid.
// Keeps only the fields needed to render it (id/type/coords/style/points/
// pen/zIndex/rotation).
function sanitizeStroke(raw: unknown): WhiteboardStroke | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  if (!id) return null;
  const type = str(r.type) || 'freedraw';
  const pts = Array.isArray(r.points) ? r.points : [];
  if (pts.length === 0) return null; // A stroke with no points is meaningless.
  const points: WhiteboardStrokePoint[] = pts.slice(0, MAX_POINTS).map((p) => {
    const point = p as Record<string, unknown> | null | undefined;
    const out: WhiteboardStrokePoint = { x: clampNum(point?.x), y: clampNum(point?.y) };
    if (point && point.p != null) out.p = clampNum(point.p);
    return out;
  });
  const s = (r.style && typeof r.style === 'object' ? r.style : {}) as Record<string, unknown>;
  const stroke: WhiteboardStroke = {
    id,
    type,
    x: clampNum(r.x),
    y: clampNum(r.y),
    width: clampNum(r.width),
    height: clampNum(r.height),
    style: {
      fill: str(s.fill) || 'none',
      stroke: str(s.stroke) || '#000000',
      strokeWidth: clampNum(s.strokeWidth, 4),
      opacity: clampNum(s.opacity, 1),
    },
    points,
  };
  if (r.pen != null) stroke.pen = str(r.pen);
  if (r.zIndex != null) stroke.zIndex = str(r.zIndex);
  if (r.rotation != null) stroke.rotation = clampNum(r.rotation);
  return stroke;
}

// A connector-style `{ x, y }` coordinate. Rejected (`undefined`) unless both
// axes are finite numbers.
function sanitizePoint(v: unknown): WhiteboardPoint | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const p = v as Record<string, unknown>;
  const x = Number(p.x);
  const y = Number(p.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return { x, y };
}

// Anything outside the allowed enum set is dropped (`undefined` — caller
// then simply doesn't write the key at all).
function sanitizeEnum<T extends string>(v: unknown, allowed: Set<T>): T | undefined {
  return typeof v === 'string' && allowed.has(v as T) ? (v as T) : undefined;
}

// Writes a shape type's own fields from `raw` into `obj`, safely. `obj`/
// `patch` (the shared coordinate/style fields) are handled by the caller —
// this only touches the fields specific to `type`.
//
// `partial=false` (a brand-new shape via `add-shape`): text/sticky have
// fields that are required on their full shape type, so when unspecified
// they're filled with a default rather than left missing.
// `partial=true` (an `update-shape` patch): only touches keys that were
// actually specified, since a partial update must never clobber fields the
// caller didn't mention.
function applyShapeTypeFields(
  obj: Record<string, unknown>,
  type: WhiteboardShapeType,
  raw: Record<string, unknown>,
  partial: boolean,
): void {
  // Geo shapes (rectangle/rounded-rect/ellipse/triangle/diamond/star) share
  // an optional centered label. All of its fields are optional regardless of
  // `partial`, so this only ever reflects what was actually specified.
  if (GEO_LABEL_TYPES.has(type)) {
    if (typeof raw.text === 'string') obj.text = str(raw.text, MAX_SHAPE_TEXT);
    if (raw.fontSize != null) obj.fontSize = clampNum(raw.fontSize, 14);
    if (raw.isEditing != null) obj.isEditing = Boolean(raw.isEditing);
  }
  if (type === 'rectangle' && raw.cornerRadius != null) {
    obj.cornerRadius = clampNum(raw.cornerRadius, 0);
  }
  if (type === 'connector') {
    // All fields are optional regardless of `partial`.
    if (raw.sourceId != null) obj.sourceId = str(raw.sourceId);
    if (raw.targetId != null) obj.targetId = str(raw.targetId);
    const sourceAnchor = sanitizeEnum(raw.sourceAnchor, ANCHOR_TYPES);
    if (sourceAnchor) obj.sourceAnchor = sourceAnchor;
    const targetAnchor = sanitizeEnum(raw.targetAnchor, ANCHOR_TYPES);
    if (targetAnchor) obj.targetAnchor = targetAnchor;
    const sourcePoint = sanitizePoint(raw.sourcePoint);
    if (sourcePoint) obj.sourcePoint = sourcePoint;
    const targetPoint = sanitizePoint(raw.targetPoint);
    if (targetPoint) obj.targetPoint = targetPoint;
    const controlPoint = sanitizePoint(raw.controlPoint);
    if (controlPoint) obj.controlPoint = controlPoint;
    if (raw.controlPointAuto != null) obj.controlPointAuto = Boolean(raw.controlPointAuto);
    const arrowHead = sanitizeEnum(raw.arrowHead, ARROW_HEADS);
    if (arrowHead) obj.arrowHead = arrowHead;
    const pathType = sanitizeEnum(raw.pathType, PATH_TYPES);
    if (pathType) obj.pathType = pathType;
    if (typeof raw.label === 'string') obj.label = str(raw.label, MAX_SHAPE_TEXT);
  }
  if (type === 'text') {
    // text/fontSize/fontFamily/isEditing are required on a full shape.
    if (!partial) {
      obj.text = typeof raw.text === 'string' ? str(raw.text, MAX_SHAPE_TEXT) : '';
      obj.fontSize = clampNum(raw.fontSize, 16);
      obj.fontFamily =
        typeof raw.fontFamily === 'string' ? str(raw.fontFamily, MAX_STR) : 'system-ui, sans-serif';
      obj.isEditing = Boolean(raw.isEditing);
    } else {
      if (typeof raw.text === 'string') obj.text = str(raw.text, MAX_SHAPE_TEXT);
      if (raw.fontSize != null) obj.fontSize = clampNum(raw.fontSize, 16);
      if (typeof raw.fontFamily === 'string') obj.fontFamily = str(raw.fontFamily, MAX_STR);
      if (raw.isEditing != null) obj.isEditing = Boolean(raw.isEditing);
    }
  }
  if (type === 'sticky') {
    // text/fontSize/stickyColor/isEditing are required on a full shape; color is always optional.
    if (!partial) {
      obj.text = typeof raw.text === 'string' ? str(raw.text, MAX_SHAPE_TEXT) : '';
      obj.fontSize = clampNum(raw.fontSize, 16);
      obj.stickyColor =
        typeof raw.stickyColor === 'string' ? str(raw.stickyColor, MAX_STR) : 'yellow';
      obj.isEditing = Boolean(raw.isEditing);
      if (typeof raw.color === 'string') obj.color = str(raw.color, MAX_STR);
    } else {
      if (typeof raw.text === 'string') obj.text = str(raw.text, MAX_SHAPE_TEXT);
      if (raw.fontSize != null) obj.fontSize = clampNum(raw.fontSize, 16);
      if (typeof raw.stickyColor === 'string') obj.stickyColor = str(raw.stickyColor, MAX_STR);
      if (raw.isEditing != null) obj.isEditing = Boolean(raw.isEditing);
      if (typeof raw.color === 'string') obj.color = str(raw.color, MAX_STR);
    }
  }
}

// Normalizes one shape into a safe shape, or `null` if invalid/oversized.
// Keeps only an allow-listed set of top-level keys (id/type/coords/style +
// per-type fields); unknown keys are silently dropped.
// Serialized byte size of a shape, used to cap how large a single shape can get.
//
// Uses `TextEncoder` rather than Node's `Buffer.byteLength`: this package is
// published for browsers as well as servers, and `Buffer` is a Node-only
// global — reaching for it here would throw `ReferenceError: Buffer is not
// defined` in a browser the moment a shape is added. Both count UTF-8 bytes
// and agree on every input, including lone surrogates, so the cap is
// unchanged.
const utf8Encoder = new TextEncoder();
function utf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).length;
}

function sanitizeShape(raw: unknown): WhiteboardShape | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  if (!id) return null;
  const type = str(r.type);
  if (!SHAPE_TYPES.has(type as WhiteboardShapeType)) return null; // Rejects freedraw and any unknown type.
  const s = (r.style && typeof r.style === 'object' ? r.style : {}) as Record<string, unknown>;
  const shape: Record<string, unknown> = {
    id,
    type,
    x: clampNum(r.x),
    y: clampNum(r.y),
    width: clampNum(r.width),
    height: clampNum(r.height),
    style: {
      fill: str(s.fill, MAX_STR) || '#ffffff',
      stroke: str(s.stroke, MAX_STR) || '#1e1e1e',
      strokeWidth: clampNum(s.strokeWidth, 2),
      opacity: clampNum(s.opacity, 1),
    },
  };
  if (r.rotation != null) shape.rotation = clampNum(r.rotation);
  if (r.zIndex != null) shape.zIndex = str(r.zIndex);
  applyShapeTypeFields(shape, type as WhiteboardShapeType, r, false);
  if (utf8ByteLength(JSON.stringify(shape)) > MAX_SHAPE_BYTES) return null;
  return shape as unknown as WhiteboardShape;
}

// Normalizes an `update-shape` patch, or `null` if invalid/empty/oversized.
// `id`/`type` can never be changed by a patch (see `reduce`'s `update-shape`
// case for why). Only the keys actually specified are validated and copied
// in — an untouched key must remain untouched (that's the point of a partial
// update). Returns `null` (rather than `{}`) when nothing valid was
// specified, so the caller can treat "empty patch" as a no-op.
function sanitizeShapePatch(
  type: WhiteboardShapeType,
  raw: unknown,
): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  if (r.x != null) patch.x = clampNum(r.x);
  if (r.y != null) patch.y = clampNum(r.y);
  if (r.width != null) patch.width = clampNum(r.width);
  if (r.height != null) patch.height = clampNum(r.height);
  if (r.rotation != null) patch.rotation = clampNum(r.rotation);
  if (r.zIndex != null) patch.zIndex = str(r.zIndex);
  if (r.style && typeof r.style === 'object') {
    const s = r.style as Record<string, unknown>;
    const style: Record<string, unknown> = {};
    // fill/stroke are only taken when they're strings: running a non-string
    // through `str()` would yield `''`, which would blank out the existing
    // color. If the value is invalid, the key is simply omitted so the
    // existing color survives the merge in `reduce`.
    if (typeof s.fill === 'string') style.fill = str(s.fill, MAX_STR);
    if (typeof s.stroke === 'string') style.stroke = str(s.stroke, MAX_STR);
    if (s.strokeWidth != null) style.strokeWidth = clampNum(s.strokeWidth, 2);
    if (s.opacity != null) style.opacity = clampNum(s.opacity, 1);
    if (Object.keys(style).length > 0) patch.style = style; // `reduce` shallow-merges this over the existing style.
  }
  applyShapeTypeFields(patch, type, r, true);
  return Object.keys(patch).length > 0 ? patch : null;
}

// Prompt/guess text. Non-strings are rejected (the caller ignores the whole
// action), valid strings are clamped to `MAX_TEXT`.
function sanitizeText(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  return v.slice(0, MAX_TEXT);
}

// A member display name, same length cap as other string fields. `str()`
// already rejects non-strings (returns `''` for anything whose `typeof`
// isn't `'string'`), so this never coerces a stringify-able value (e.g.
// `{ toString: () => 'alice' }`) into a name — such values fall through to
// `null`, same as an outright missing name.
function sanitizeName(v: unknown): string | null {
  const s = str(v);
  return s || null;
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
function totalRoundsFor(playerCount: number): number {
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
function submitToChain(
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
 * The API returned by `createWhiteboardState`.
 */
export interface WhiteboardStateApi {
  defaultState: () => WhiteboardState;
  /**
   * Applies an action to the current state, returning the next state or
   * `null` if the action is invalid/a no-op and should be ignored.
   *
   * `action` is typed as `string` rather than `WhiteboardAction` on purpose:
   * this function sits behind a wire boundary where the action name is
   * untrusted input, and any string outside the known set falls through to
   * `null` (see `default` below).
   */
  reduce: (
    state: WhiteboardState | null | undefined,
    action: string,
    payload?: WhiteboardPayload,
  ) => WhiteboardState | null;
  /**
   * Milliseconds until the next event (a relay phase expiring), or `null` if
   * there's nothing to wait for.
   */
  timerDelay: (state: WhiteboardState) => number | null;
  /**
   * Called when a relay phase expires: fills a placeholder entry for every
   * player who hasn't submitted, then advances the round.
   */
  onTimer: (state: WhiteboardState) => WhiteboardState | null;
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

  function reduce(
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
        if (utf8ByteLength(JSON.stringify(next)) > MAX_SHAPE_BYTES) return null;
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

  function onTimer(state: WhiteboardState): WhiteboardState | null {
    const game = state.game;
    if (!game) return null;
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
    return { ...state, game: advanceRound(g) };
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

  return { defaultState, reduce, timerDelay, onTimer, restore };
}

// ── As a space extension ───────────────────────────────────────────────────

/** Options for `whiteboardExtension`. Everything `createWhiteboardState` takes, plus a name. */
export interface WhiteboardExtensionOptions {
  /** See `createWhiteboardState`. Required for the same reason it is required there. */
  isOwnImageUrl: (url: string) => boolean;
  /**
   * The key this extension occupies in space state, and the identifier its
   * updates are broadcast under. Defaults to `'whiteboard'`.
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
 */
export function whiteboardExtension(options: WhiteboardExtensionOptions) {
  return {
    name: options?.name ?? 'whiteboard',
    // Passed through rather than spread, so the missing-predicate check in
    // `createWhiteboardState` stays the single place that guards it.
    server: createWhiteboardState({ isOwnImageUrl: options?.isOwnImageUrl }),
  };
}
