// Everything that turns untrusted input into a shape the reducer may rely on.
//
// Both boundaries this package has — the wire (`reduce`) and storage
// (`restore`, plus the drafts and snapshots the host hands back) — normalize
// through these, so a value that round-trips through the host is clamped
// exactly like one that just arrived.

import type { ChatDraft, ChatPinnedMessage } from './types.ts';

// Caps against state bloat and adversarial oversized payloads.
export const MAX_TEXT_LEN = 500;
export const MAX_URL_LEN = 500;
export const MAX_NAME_LEN = 100;
export const MAX_UID_LEN = 64;
export const MAX_CLIENT_MSG_ID_LEN = 64;
const MAX_EMOJI_LEN = 8;

// A single emoji "character" as a user perceives it. Reaction pickers let
// people choose any Unicode emoji, so a fixed list can't validate them —
// instead require exactly one grapheme cluster that contains a pictographic
// code point, which keeps ordinary text (a whole sentence, say) from being
// smuggled in as a reaction.
const EXTENDED_PICTOGRAPHIC_RE = /\p{Extended_Pictographic}/u;

/**
 * Whether `emoji` is acceptable as a per-message reaction: a single
 * user-perceived character containing a pictographic code point.
 *
 * Exported because hosts often need the same check at another boundary (an
 * HTTP endpoint, an import job) and duplicating it is how the two drift.
 */
export function isValidReactionEmoji(emoji: unknown): emoji is string {
  if (typeof emoji !== 'string' || emoji.length === 0 || emoji.length > MAX_EMOJI_LEN) return false;
  if (!EXTENDED_PICTOGRAPHIC_RE.test(emoji)) return false;
  return [...new Intl.Segmenter().segment(emoji)].length === 1;
}

// Non-strings become `''` rather than being coerced with `String(v)`. The
// server this was ported from used `String(msg.text || '')`, which turns a
// stray object into the literal text "[object Object]" — a wire boundary
// shouldn't invent content that way.
export function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

// A display name / uid / URL. Non-strings and empty strings both become
// `null` (there's no meaningful "empty name").
export function nullableStr(v: unknown, max: number): string | null {
  const s = str(v, max);
  return s || null;
}

// A storage id: a positive integer, accepted as either a number or the
// numeric string a JSON transport may deliver it as (large ids are commonly
// serialized as strings to survive `Number.MAX_SAFE_INTEGER`). Anything else
// — fractional, zero, negative, non-finite, non-numeric — becomes `null`.
export function parseId(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Normalizes a pinned-message snapshot coming from the host (either freshly
// looked up, or loaded from storage on restart). Returns `null` for anything
// that isn't a usable snapshot, which callers treat as "don't pin".
export function sanitizePinned(raw: unknown): ChatPinnedMessage | null {
  if (!isPlainObject(raw)) return null;
  const id = parseId(raw.id);
  if (id === null) return null;
  const createdAt =
    typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : undefined;
  const imageUrl = nullableStr(raw.imageUrl, MAX_URL_LEN);
  const isSticker = raw.kind === 'sticker' && imageUrl !== null;
  return {
    id,
    name: str(raw.name, MAX_NAME_LEN),
    text: str(raw.text, MAX_TEXT_LEN),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(isSticker ? { kind: 'sticker' as const, imageUrl } : {}),
  };
}

// Normalizes a draft that has round-tripped through the host. It left this
// module well-formed, but it came back across an `unknown` boundary, so it's
// re-validated rather than trusted.
export function sanitizeDraft(raw: unknown): ChatDraft | null {
  if (!isPlainObject(raw)) return null;
  const imageUrl = nullableStr(raw.imageUrl, MAX_URL_LEN);
  const kind = raw.kind === 'sticker' && imageUrl !== null ? 'sticker' : 'text';
  const text = kind === 'sticker' ? '' : str(raw.text, MAX_TEXT_LEN);
  if (kind === 'text' && !text.trim()) return null;
  const createdAt =
    typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : 0;
  return {
    kind,
    text,
    imageUrl: kind === 'sticker' ? imageUrl : null,
    replyToId: parseId(raw.replyToId),
    clientMsgId: nullableStr(raw.clientMsgId, MAX_CLIENT_MSG_ID_LEN),
    by: nullableStr(raw.by, MAX_NAME_LEN),
    uid: nullableStr(raw.uid, MAX_UID_LEN),
    avatar: nullableStr(raw.avatar, MAX_URL_LEN),
    createdAt,
  };
}
