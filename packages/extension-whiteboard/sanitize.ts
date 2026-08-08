// Everything that turns untrusted input into a shape the reducer may rely on,
// plus the caps that keep stored state bounded.
//
// Both boundaries this package has — the wire (`reduce`) and storage
// (`restore`) — normalize through these, so a stroke read back after a
// restart is clamped exactly like one that just arrived.
//
// Note the one thing that is deliberately *not* here: the submitted-drawing
// URL check. Whether a URL belongs to the host's own storage is host-specific
// knowledge, so it is injected into `createWhiteboardState` rather than
// hard-coded — see that function's doc comment.

import type {
  AnchorType,
  ArrowHead,
  PathType,
  WhiteboardPoint,
  WhiteboardShape,
  WhiteboardShapeType,
  WhiteboardStroke,
  WhiteboardStrokePoint,
} from './types.ts';

// Caps against state bloat and adversarial oversized payloads.
export const MAX_STROKES = 2000; // Confirmed strokes per board. Oldest are dropped once exceeded.
const MAX_POINTS = 5000; // Points per stroke.
const MAX_STR = 64; // Length cap for id/type/pen-style string fields.

export const MAX_SHAPES = 500; // Shapes per board. New additions are rejected once exceeded.
const MAX_SHAPE_TEXT = 500; // Length cap for text/label fields on shapes.
const MAX_SHAPE_BYTES = 8 * 1024; // Serialized-size cap per shape.

// Prompt/guess text length cap (relay game).
const MAX_TEXT = 100;

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

export function clampNum(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function str(v: unknown, max = MAX_STR): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

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

/** Whether a shape (or a patched shape) is within the per-shape size cap. */
export function withinShapeByteCap(shape: unknown): boolean {
  return utf8ByteLength(JSON.stringify(shape)) <= MAX_SHAPE_BYTES;
}

// Normalizes one freedraw stroke into a safe shape, or `null` if invalid.
// Keeps only the fields needed to render it (id/type/coords/style/points/
// pen/zIndex/rotation).
export function sanitizeStroke(raw: unknown): WhiteboardStroke | null {
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
export function sanitizeShape(raw: unknown): WhiteboardShape | null {
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
  if (!withinShapeByteCap(shape)) return null;
  return shape as unknown as WhiteboardShape;
}

// Normalizes an `update-shape` patch, or `null` if invalid/empty/oversized.
// `id`/`type` can never be changed by a patch (see `reduce`'s `update-shape`
// case for why). Only the keys actually specified are validated and copied
// in — an untouched key must remain untouched (that's the point of a partial
// update). Returns `null` (rather than `{}`) when nothing valid was
// specified, so the caller can treat "empty patch" as a no-op.
export function sanitizeShapePatch(
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
export function sanitizeText(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  return v.slice(0, MAX_TEXT);
}

// A member display name, same length cap as other string fields. `str()`
// already rejects non-strings (returns `''` for anything whose `typeof`
// isn't `'string'`), so this never coerces a stringify-able value (e.g.
// `{ toString: () => 'alice' }`) into a name — such values fall through to
// `null`, same as an outright missing name.
export function sanitizeName(v: unknown): string | null {
  const s = str(v);
  return s || null;
}
