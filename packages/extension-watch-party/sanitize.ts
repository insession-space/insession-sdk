// Everything that turns untrusted input into a shape the reducer may rely on,
// plus the caps that keep stored state bounded.
//
// Both boundaries this package has — the wire (`reduce`) and storage
// (`restore`) — normalize through these, so an item read back after a restart
// is clamped exactly like one that just arrived.

import type { WatchPartyHistoryItem, WatchPartyProvider, WatchPartyQueueItem } from './types.ts';

// Caps against state bloat and adversarial oversized payloads.
export const DEFAULT_MAX_QUEUE = 50;
export const MAX_HISTORY = 50;
export const MAX_YOUTUBE_ID_LEN = 20; // Actual YouTube ids are 11 chars; this is just a pre-regex safety net.
export const MAX_SOUNDCLOUD_ID_LEN = 160;
export const MAX_PODCAST_ID_LEN = 40; // `podcast-<8 hex>-<8 hex>` is 26 chars; this is just a pre-regex safety net.
export const MAX_SPOTIFY_ID_LEN = 40; // `spotify-playlist-<22 chars>` (the longest kind) is 39 chars; this is just a pre-regex safety net.
export const MAX_TITLE_LEN = 200;
export const MAX_URL_LEN = 500;
const MAX_NAME_LEN = 100;
export const MAX_UID_LEN = 64;

// YouTube video ids are always 11 chars of [A-Za-z0-9_-]. This is a stable,
// public fact about YouTube's id format (not an InSession business rule), so
// unlike `pickShuffleIndex` (point (c) in the module's design notes) it's safe
// to encode directly here rather than require injection.
const VIDEO_ID_RE = /^[\w-]{11}$/;
// SoundCloud has no public id of its own, so the app that ported this module
// represents a track/set with a pseudo-id of this shape (see that module's
// own doc comment for the encoding). Same reasoning as above: this is a
// stable id-shape convention, not app policy, so it's encoded directly here.
const SOUNDCLOUD_ID_RE = /^sc-(track|set)-[\w./-]{1,128}$/;
// Podcasts have no single public id either — the app that ported this module
// represents an episode with a pseudo-id of this shape (`podcast-<feed
// hash>-<episode hash>`, both 8 hex chars). Same reasoning as above.
const PODCAST_ID_RE = /^podcast-[0-9a-f]{8}-[0-9a-f]{8}$/;
// Spotify ids are base62 and always 22 chars — a stable, public fact about
// Spotify's id format. The app that ported this module prefixes them with the
// content kind so the shape alone identifies both the provider and what to
// play (a bare 22-char id would otherwise be indistinguishable from other
// opaque ids, and the same id space is reused across kinds). Same reasoning as
// above.
// ⚠ Keep this a superset: `spotify-episode-*` ids are already persisted by
// hosts that shipped on an earlier version, so kinds may only ever be added.
// `show` is deliberately absent — a show is a series, not something playable.
const SPOTIFY_ID_RE = /^spotify-(?:track|album|playlist|episode)-[A-Za-z0-9]{22}$/;

export function isValidMediaId(provider: WatchPartyProvider, id: unknown): id is string {
  if (typeof id !== 'string' || !id) return false;
  if (provider === 'soundcloud') return SOUNDCLOUD_ID_RE.test(id);
  if (provider === 'podcast') return PODCAST_ID_RE.test(id);
  if (provider === 'spotify') return SPOTIFY_ID_RE.test(id);
  return VIDEO_ID_RE.test(id);
}

export function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

// A display name / uid. Non-strings and empty strings both become `null`
// (there's no meaningful "empty name").
export function normName(v: unknown): string | null {
  const s = str(v, MAX_NAME_LEN);
  return s || null;
}

export function providerOf(v: unknown): WatchPartyProvider {
  if (v === 'soundcloud') return 'soundcloud';
  if (v === 'podcast') return 'podcast';
  if (v === 'spotify') return 'spotify';
  return 'youtube';
}

// SoundCloud, podcast and Spotify items all carry a host-provided `mediaUrl`,
// rather than a provider-native id the client resolves itself (as YouTube's
// embed does from `videoId`) — see `reduce.ts`'s `load-video`/`queue-add`
// handling.
//
// Note Spotify's `mediaUrl` is the episode's public page URL, kept for display
// and outbound links: unlike SoundCloud/podcast it is not the stream the player
// consumes (Spotify's own embed resolves that from the id). It still belongs
// here because the field must survive sanitization for the host to use it.
export function isExternalMediaProvider(provider: WatchPartyProvider): boolean {
  return provider === 'soundcloud' || provider === 'podcast' || provider === 'spotify';
}

/** The id-length cap that applies to `provider`'s ids. */
export function mediaIdMaxLen(provider: WatchPartyProvider): number {
  if (provider === 'soundcloud') return MAX_SOUNDCLOUD_ID_LEN;
  if (provider === 'podcast') return MAX_PODCAST_ID_LEN;
  if (provider === 'spotify') return MAX_SPOTIFY_ID_LEN;
  return MAX_YOUTUBE_ID_LEN;
}

// Non-negative integer seconds, or `null` for anything else (missing,
// fractional, negative, non-finite). No Postgres-specific upper bound here
// (unlike the app this was ported from) — that's a storage detail the host
// owns, not something this package should assume.
export function sanitizeDurationSec(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  return value;
}

// Validates a client-submitted playback position (seconds). Rejects
// undefined/NaN/negative/non-finite rather than coercing them to 0 with
// `Number(x) || 0` — that coercion would silently rewind everyone in the
// space to the start of the video on any malformed/missing value, which is
// the worst possible fallback for a "position" field.
export function parsePosition(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// Normalizes one persisted queue item into a safe shape, or `null` if it's
// missing the minimum required fields. Used only by `restore`.
export function sanitizeRestoredQueueItem(raw: unknown): WatchPartyQueueItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const provider = providerOf(r.provider);
  const videoId = str(r.videoId, mediaIdMaxLen(provider));
  if (!isValidMediaId(provider, videoId)) return null;
  const uid = str(r.uid, MAX_UID_LEN);
  if (!uid) return null;
  const addSeqNum = Math.trunc(Number(r.addSeq));
  return {
    uid,
    videoId,
    provider,
    mediaUrl: typeof r.mediaUrl === 'string' ? str(r.mediaUrl, MAX_URL_LEN) : null,
    thumbnail: typeof r.thumbnail === 'string' ? str(r.thumbnail, MAX_URL_LEN) : null,
    title: typeof r.title === 'string' ? str(r.title, MAX_TITLE_LEN) : null,
    durationSec: sanitizeDurationSec(r.durationSec),
    addedBy: normName(r.addedBy),
    addedByUid: normName(r.addedByUid),
    addSeq: Number.isFinite(addSeqNum) ? addSeqNum : 0,
  };
}

// Normalizes one persisted history item into a safe shape, or `null` if it's
// missing the minimum required fields. Used only by `restore`.
export function sanitizeRestoredHistoryItem(
  raw: unknown,
  index: number,
): WatchPartyHistoryItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const provider = providerOf(r.provider);
  const videoId = str(r.videoId, mediaIdMaxLen(provider));
  if (!isValidMediaId(provider, videoId)) return null;
  const uid = str(r.uid, MAX_UID_LEN) || `h${index + 1}`;
  const ts = Math.trunc(Number(r.ts));
  return {
    uid,
    videoId,
    provider,
    mediaUrl: typeof r.mediaUrl === 'string' ? str(r.mediaUrl, MAX_URL_LEN) : null,
    thumbnail: typeof r.thumbnail === 'string' ? str(r.thumbnail, MAX_URL_LEN) : null,
    title: typeof r.title === 'string' ? str(r.title, MAX_TITLE_LEN) : null,
    durationSec: sanitizeDurationSec(r.durationSec),
    by: normName(r.by),
    byUid: normName(r.byUid),
    ts: Number.isFinite(ts) && ts > 0 ? ts : Date.now(),
  };
}
