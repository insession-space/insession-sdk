// Server-authoritative Watch Party state machine: synchronized playback of a
// single "now playing" item (YouTube video or SoundCloud track) plus a queue
// and a play history.
//
// Sync model: the server owns `videoId`/`provider`/`isPlaying`/`position`.
// While playing, position is *not* ticked every second — it's derived on
// demand by wall-clock extrapolation (`currentPosition`), so the server only
// has to broadcast on actual play/pause/seek/load events (plus an occasional
// `request-sync` for a client that needs to catch up, e.g. after returning
// from a backgrounded tab).
//
// Unlike `plugin-whiteboard-state`/`plugin-pomodoro-state`, this module
// genuinely has side effects worth doing (broadcast a message, persist
// playback position, ask the host to resolve a title). Rather than take
// callbacks, `reduce` returns `{ state, effects }` — a list of effect
// descriptors the host interprets and executes — following the same
// convention `@insession/space-state`'s `reduceSpace` already uses. This
// keeps `reduce` itself pure and testable without mocking I/O.
//
// `null` return value means "ignore this action" (invalid payload, or a
// genuine no-op — e.g. seeking with a garbage position, or `pause`, which is
// *always* a no-op by design; see its case below).

/** Which backend the "now playing" item and each queue/history item came from. */
export type WatchPartyProvider = 'youtube' | 'soundcloud';

/** One item waiting to be played. */
export interface WatchPartyQueueItem {
  /** Stable id for this queue entry, used to target `queue-remove`/`queue-reorder`/`queue-play`. */
  uid: string;
  videoId: string;
  provider: WatchPartyProvider;
  /** SoundCloud's permalink URL. `null` for YouTube (unused there). */
  mediaUrl: string | null;
  /** SoundCloud's artwork URL. `null` for YouTube (the client derives a thumbnail from `videoId`). */
  thumbnail: string | null;
  /** `null` until resolved — see the `queue-add`/`resolve-metadata` flow in the module doc below. */
  title: string | null;
  /** `null` if unknown (not yet resolved, or the provider doesn't expose a duration). */
  durationSec: number | null;
  addedBy: string | null;
  addedByUid: string | null;
  /**
   * Monotonically increasing per-state insertion sequence number, used by
   * `insertByAddSeq` to keep the queue in *send* order even when items with
   * host-side resolution delays (e.g. an awaited duration lookup) land out
   * of order. See `insertByAddSeq`'s doc comment.
   */
  addSeq: number;
}

/** One entry in the play history (most recent first). */
export interface WatchPartyHistoryItem {
  /** Stable id for this history entry, used to target a `resolve-metadata` patch. */
  uid: string;
  videoId: string;
  provider: WatchPartyProvider;
  mediaUrl: string | null;
  thumbnail: string | null;
  title: string | null;
  durationSec: number | null;
  by: string | null;
  byUid: string | null;
  /** Epoch ms when this item started playing. */
  ts: number;
}

export interface WatchPartyState {
  videoId: string | null;
  provider: WatchPartyProvider | null;
  mediaUrl: string | null;
  thumbnail: string | null;
  isPlaying: boolean;
  /** Seconds, as of `lastUpdate`. */
  position: number;
  /** Epoch ms when `position` was last recorded. */
  lastUpdate: number;
  queue: WatchPartyQueueItem[];
  /** Most recent first, capped at 50. */
  history: WatchPartyHistoryItem[];
  /** Source of the next queue item's `addSeq`/`uid` (internal bookkeeping — see `WatchPartyQueueItem.addSeq`). */
  queueSeq: number;
  /** Source of the next history item's `uid` (internal bookkeeping). */
  historySeq: number;
}

export type WatchPartyAction =
  | 'load-video'
  | 'play'
  | 'pause'
  | 'seek'
  | 'video-ended'
  | 'request-sync'
  | 'queue-add'
  | 'queue-remove'
  | 'queue-clear'
  | 'queue-reorder'
  | 'queue-play'
  | 'queue-play-next'
  | 'resolve-metadata';

/**
 * Payload shapes for each action. Fields are loosely typed because `reduce`
 * treats the payload as untrusted wire data — every field is validated (and
 * safely ignored or rejected) at the point of use. A few fields
 * (`shuffleEnabled`, `mixActive`, `maxQueueLength`, `maxPerUser`,
 * `maxDurationSec`) are host-trusted *settings* rather than wire data
 * proper — the host is expected to read them from its own space settings and
 * fold them into the payload before calling `reduce`, the same way
 * `plugin-pomodoro-state`'s payload expects the host to inject `by`/`uid`
 * from the authenticated sender rather than trusting the wire for those.
 */
export interface WatchPartyPayload {
  /** `load-video`/`queue-add`: defaults to `'youtube'` if omitted/invalid. */
  provider?: unknown;
  /** `load-video`/`queue-add`: the video/track id (YouTube id or SoundCloud pseudo-id). */
  videoId?: unknown;
  /** `load-video`/`queue-add` (SoundCloud only): the permalink URL. */
  mediaUrl?: unknown;
  /** `load-video`/`queue-add` (SoundCloud only): the artwork URL. */
  thumbnail?: unknown;
  /** `load-video`/`queue-add`: title, if already known (skips the `resolve-metadata` round trip). */
  title?: unknown;
  /** `load-video`/`queue-add`: duration in seconds, if already known. */
  durationSec?: unknown;
  /** `play`/`seek`: target position in seconds. */
  position?: unknown;
  /** `play`/`seek`/`queue-play`/`queue-play-next`: the acting member's display name. */
  by?: unknown;
  /** `queue-play`/`queue-play-next`: the acting member's stable user id, if signed in. */
  byUid?: unknown;
  /** `video-ended`: the video id the client believes just ended (only the current one is honored). */
  // (reuses `videoId` above)
  /** `queue-add`: the adding member's display name/uid. */
  addedBy?: unknown;
  addedByUid?: unknown;
  /** `queue-remove`/`queue-reorder`/`queue-play`: the target queue item's `uid`. */
  uid?: unknown;
  /** `queue-reorder`: the destination index. */
  toIndex?: unknown;
  /**
   * `queue-play-next`/`video-ended`/`queue-add`'s auto-play branch: whether
   * the host's shuffle setting is on for this space. Host-trusted (see class
   * doc comment) — `reduce` never reads a space's settings itself.
   */
  shuffleEnabled?: unknown;
  /**
   * `video-ended` only: whether the host's mix/autoplay-next feature (out of
   * this package's scope — see the `video-ended` case below) will take over
   * from here. When `true`, `reduce` does nothing at all: no queue advance,
   * no freeze. See point (a) in the module's design notes.
   */
  mixActive?: unknown;
  /**
   * `queue-add`: arrival-order stamp. A host that awaits anything before
   * calling `reduce` (resolving a duration, fetching a title) should capture a
   * monotonically increasing number *before* that await and pass it here, so
   * the queue keeps send order even when lookups resolve out of order. Omit it
   * and `reduce` assigns one at call time, which is only correct for hosts
   * that never await first.
   */
  addSeq?: unknown;
  /** `queue-add`: caps the host resolves from its own space settings. Omitted means "no cap". */
  maxQueueLength?: unknown;
  maxPerUser?: unknown;
  maxDurationSec?: unknown;
  /** `resolve-metadata`: which list the `uid` refers to. Defaults to `'queue'`. */
  kind?: unknown;
  /**
   * Payload is untrusted wire data assembled by the host, so it may carry
   * fields beyond the ones named above — this keeps that assignable without
   * a cast.
   */
  [key: string]: unknown;
}

/**
 * Side effects `reduce` asks the host to perform. `reduce` never performs
 * I/O itself — it only describes what should happen; the host interprets and
 * executes each descriptor (broadcast over its transport, write to its DB,
 * call its own title/duration-lookup API, ...). This mirrors
 * `@insession/space-state`'s `SpaceEffect` in both shape and intent.
 */
export type WatchPartyEffect =
  /** Send `message` to every connected member of the space. */
  | { type: 'broadcast'; message: unknown; excludeSender?: boolean }
  /** Send `message` only to whoever triggered the action (e.g. `request-sync`'s reply). */
  | { type: 'send-to-sender'; message: unknown }
  /** Persist the now-playing position/state (mirrors the host's own DB call). */
  | { type: 'persist-playback'; videoId: string | null; isPlaying: boolean; position: number }
  /** Persist the now-playing item's provider-specific media fields. */
  | {
      type: 'persist-media';
      provider: WatchPartyProvider | null;
      mediaUrl: string | null;
      thumbnail: string | null;
    }
  /**
   * Ask the host to resolve a title/duration this package can't fetch itself
   * (see point (b) in the module's design notes), then feed the result back
   * via a `resolve-metadata` action carrying the same `uid`/`kind`.
   */
  | {
      type: 'resolve-metadata';
      /** Correlates the host's eventual `resolve-metadata` action back to this item. */
      uid: string;
      /** Which list `uid` lives in. */
      kind: 'queue' | 'history';
      videoId: string;
      provider: WatchPartyProvider;
      mediaUrl: string | null;
      by: string | null;
      byUid: string | null;
      durationSec: number | null;
    };

// Caps against state bloat and adversarial oversized payloads.
const DEFAULT_MAX_QUEUE = 50;
const MAX_HISTORY = 50;
const MAX_YOUTUBE_ID_LEN = 20; // Actual YouTube ids are 11 chars; this is just a pre-regex safety net.
const MAX_SOUNDCLOUD_ID_LEN = 160;
const MAX_TITLE_LEN = 200;
const MAX_URL_LEN = 500;
const MAX_NAME_LEN = 100;
const MAX_UID_LEN = 64;

// YouTube video ids are always 11 chars of [A-Za-z0-9_-]. This is a stable,
// public fact about YouTube's id format (not an InSession business rule), so
// unlike `pickShuffleIndex` (point (c) below) it's safe to encode directly
// here rather than require injection.
const VIDEO_ID_RE = /^[\w-]{11}$/;
// SoundCloud has no public id of its own, so the app that ported this module
// represents a track/set with a pseudo-id of this shape (see that module's
// own doc comment for the encoding). Same reasoning as above: this is a
// stable id-shape convention, not app policy, so it's encoded directly here.
const SOUNDCLOUD_ID_RE = /^sc-(track|set)-[\w./-]{1,128}$/;

function isValidMediaId(provider: WatchPartyProvider, id: unknown): id is string {
  if (typeof id !== 'string' || !id) return false;
  return provider === 'soundcloud' ? SOUNDCLOUD_ID_RE.test(id) : VIDEO_ID_RE.test(id);
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

// A display name / uid. Non-strings and empty strings both become `null`
// (there's no meaningful "empty name").
function normName(v: unknown): string | null {
  const s = str(v, MAX_NAME_LEN);
  return s || null;
}

function providerOf(v: unknown): WatchPartyProvider {
  return v === 'soundcloud' ? 'soundcloud' : 'youtube';
}

// Non-negative integer seconds, or `null` for anything else (missing,
// fractional, negative, non-finite). No Postgres-specific upper bound here
// (unlike the app this was ported from) — that's a storage detail the host
// owns, not something this package should assume.
function sanitizeDurationSec(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  return value;
}

// Validates a client-submitted playback position (seconds). Rejects
// undefined/NaN/negative/non-finite rather than coercing them to 0 with
// `Number(x) || 0` — that coercion would silently rewind everyone in the
// space to the start of the video on any malformed/missing value, which is
// the worst possible fallback for a "position" field.
function parsePosition(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * The current playback position, extrapolated by wall clock while playing so
 * the host doesn't have to broadcast a position update every second. While
 * stopped, this is just the recorded value.
 */
export function currentPosition(state: WatchPartyState): number {
  if (!state.isPlaying) return state.position;
  return state.position + (Date.now() - state.lastUpdate) / 1000;
}

function setPosition(
  state: WatchPartyState,
  position: number,
  isPlaying: boolean,
): WatchPartyState {
  return { ...state, position, isPlaying, lastUpdate: Date.now() };
}

/**
 * The default state for a space that doesn't have Watch Party state yet.
 * Exported at the top level (unlike the rest of the API) because it doesn't
 * depend on any of `createWatchParty`'s arguments — callers who only need a
 * fallback/initial value don't need to construct the factory just for this.
 */
export function defaultState(): WatchPartyState {
  return {
    videoId: null,
    provider: null,
    mediaUrl: null,
    thumbnail: null,
    isPlaying: false,
    position: 0,
    lastUpdate: Date.now(),
    queue: [],
    history: [],
    queueSeq: 0,
    historySeq: 0,
  };
}

// Strips fields the client has no business seeing before an item is
// broadcast (`addedByUid`/`addSeq` on queue items). This is done here, at
// the point a `broadcast` effect is constructed, rather than left to the
// host — the same way `plugin-whiteboard-state` fully sanitizes a shape
// before handing it back, so a host can't forget the step. See point (e) in
// the module's design notes. Effects other than `broadcast` (e.g.
// `persist-playback`) are for the host's own storage, which is free to keep
// these fields.
function stripQueueForBroadcast(
  queue: WatchPartyQueueItem[],
): Omit<WatchPartyQueueItem, 'addedByUid' | 'addSeq'>[] {
  return queue.map(({ addedByUid: _addedByUid, addSeq: _addSeq, ...rest }) => rest);
}

function stripHistoryForBroadcast(
  history: WatchPartyHistoryItem[],
): Omit<WatchPartyHistoryItem, 'byUid'>[] {
  return history.map(({ byUid: _byUid, ...rest }) => rest);
}

// Insert `item` at the position that keeps the queue in *send* order, even
// when items resolve (land in state) out of the order they were sent in —
// e.g. a host that awaits a duration-cap lookup before calling `reduce` for
// one `queue-add` while a faster, later `queue-add` lands first. `addSeq` is
// assigned by the host-visible `queueSeq` counter (monotonically increasing
// per state), so a newly-added item's `addSeq` is always the largest seen so
// far — it lands at the tail in the common case (no reordering in flight),
// and only slots in earlier when an item with a *larger* `addSeq` already
// landed ahead of it (i.e. a later item's `reduce` call resolved first).
//
// Items with no `addSeq` (e.g. restored from storage before this field
// existed, or simply omitted by a caller) sort to the front: they represent
// send order from *before* the current process, so a newly-added item can
// never rightfully precede them.
function insertByAddSeq(
  queue: WatchPartyQueueItem[],
  item: WatchPartyQueueItem,
): WatchPartyQueueItem[] {
  const at = queue.findIndex((q) => (q.addSeq ?? -Infinity) > item.addSeq);
  if (at === -1) return [...queue, item];
  const next = queue.slice();
  next.splice(at, 0, item);
  return next;
}

interface PlayInfo {
  videoId: string;
  provider: WatchPartyProvider;
  mediaUrl: string | null;
  thumbnail: string | null;
  title: string | null;
  durationSec: number | null;
  by: string | null;
  byUid: string | null;
}

// Transitions `state` to "now playing `info`": resets position, records a
// history entry, and returns the effects a host needs to broadcast the
// change and persist it. Shared by every action that starts a new item
// playing (`load-video`, `queue-play`, and the queue-advance path used by
// `queue-play-next`/`video-ended`/`queue-add`'s auto-play branch).
function playNow(
  state: WatchPartyState,
  info: PlayInfo,
): { state: WatchPartyState; effects: WatchPartyEffect[] } {
  const withPosition = setPosition(
    {
      ...state,
      videoId: info.videoId,
      provider: info.provider,
      mediaUrl: info.mediaUrl,
      thumbnail: info.thumbnail,
    },
    0,
    true,
  );
  const historySeq = state.historySeq + 1;
  const historyItem: WatchPartyHistoryItem = {
    uid: `h${historySeq}`,
    videoId: info.videoId,
    provider: info.provider,
    mediaUrl: info.mediaUrl,
    thumbnail: info.thumbnail,
    title: info.title,
    durationSec: info.durationSec,
    by: info.by,
    byUid: info.byUid,
    ts: Date.now(),
  };
  let history = [historyItem, ...state.history];
  if (history.length > MAX_HISTORY) history = history.slice(0, MAX_HISTORY);
  const next: WatchPartyState = { ...withPosition, history, historySeq };

  const effects: WatchPartyEffect[] = [
    {
      type: 'broadcast',
      message: {
        type: 'load-video',
        videoId: info.videoId,
        provider: info.provider,
        mediaUrl: info.mediaUrl,
        thumbnail: info.thumbnail,
        by: info.by,
      },
    },
    {
      type: 'persist-playback',
      videoId: next.videoId,
      isPlaying: next.isPlaying,
      position: next.position,
    },
    {
      type: 'persist-media',
      provider: next.provider,
      mediaUrl: next.mediaUrl,
      thumbnail: next.thumbnail,
    },
    {
      type: 'broadcast',
      message: { type: 'history-update', history: stripHistoryForBroadcast(next.history) },
    },
  ];
  // See point (b) in the module's design notes: this package doesn't fetch
  // titles/durations itself. When the caller didn't already know the title,
  // it's recorded as `null` and the host is asked to resolve it and feed the
  // result back via `resolve-metadata`.
  if (info.title === null) {
    effects.push({
      type: 'resolve-metadata',
      uid: historyItem.uid,
      kind: 'history',
      videoId: info.videoId,
      provider: info.provider,
      mediaUrl: info.mediaUrl,
      by: info.by,
      byUid: info.byUid,
      durationSec: info.durationSec,
    });
  }
  return { state: next, effects };
}

// Pops one item off the queue and starts it playing (`playNow`). `index`
// selection is FIFO (`0`) unless `shuffleEnabled` and a `pickShuffleIndex`
// were supplied — see point (c) in the module's design notes for why the
// shuffle algorithm itself is injected rather than reimplemented here.
// Returns `null` if the queue is empty (nothing to advance to — the caller
// decides what "nothing to play" means for its action).
function advanceQueue(
  state: WatchPartyState,
  shuffleEnabled: boolean,
  actor: { by: string | null; byUid: string | null },
  pickShuffleIndex: PickShuffleIndex | undefined,
): { state: WatchPartyState; effects: WatchPartyEffect[] } | null {
  if (state.queue.length === 0) return null;
  const index =
    shuffleEnabled && pickShuffleIndex ? pickShuffleIndex(state.queue, state.videoId) : 0;
  const item = state.queue[index] ?? state.queue[0];
  const queue = state.queue.filter((_, i) => i !== index);
  const { state: played, effects } = playNow(
    { ...state, queue },
    {
      videoId: item.videoId,
      provider: item.provider,
      mediaUrl: item.mediaUrl,
      thumbnail: item.thumbnail,
      title: item.title,
      durationSec: item.durationSec,
      by: actor.by,
      byUid: actor.byUid,
    },
  );
  return {
    state: played,
    effects: [
      {
        type: 'broadcast',
        message: { type: 'queue-update', queue: stripQueueForBroadcast(played.queue) },
      },
      ...effects,
    ],
  };
}

type PickShuffleIndex = (
  items: { videoId?: string | null }[],
  currentVideoId?: string | null,
) => number;

export interface CreateWatchPartyOptions {
  /**
   * Picks which queue index to play next when shuffle is on (`shuffleEnabled`
   * in the payload of `queue-play-next`/`video-ended`/`queue-add`'s
   * auto-play branch). Omit to always advance FIFO (index 0), i.e. shuffle
   * behaves as if disabled.
   *
   * This is **injected rather than implemented here on purpose** (point (c)
   * in the module's design notes): the app this was ported from shares one
   * shuffle implementation between Watch Party and an unrelated "my room"
   * feature specifically so "random" means the same thing in both places.
   * Bundling a second implementation into this package would let the two
   * drift. If you don't have your own, any function that returns a valid
   * index into `items` works — e.g. `(items) => Math.floor(Math.random() *
   * items.length)`.
   */
  pickShuffleIndex?: PickShuffleIndex;
  /**
   * The `by` value stamped on items that start playing without a specific
   * acting member — `queue-add`'s "nothing was playing, so play this new
   * item immediately" branch, and `video-ended`'s queue-advance branch.
   * Lets a host's UI distinguish "the queue advanced this on its own" from
   * "a member pressed play". Defaults to `'queue'`.
   *
   * This package doesn't ship a localized/branded sentinel the way the app
   * it was ported from does (an opaque, language-independent marker string
   * its own UI compares against) — that's presentation policy. Pass your
   * own value here if you want one distinct from real member display names.
   */
  autoAdvanceBy?: string;
}

/**
 * The API returned by `createWatchParty`.
 */
/**
 * What `reduce` returns when it accepts an action: the next state, plus the
 * effects the host must carry out (broadcast, persist, resolve metadata).
 * `reduce` returns `null` instead when the action is invalid or a no-op.
 */
export interface WatchPartyReduceResult {
  state: WatchPartyState;
  effects: WatchPartyEffect[];
}

export interface WatchPartyStateApi {
  defaultState: () => WatchPartyState;
  currentPosition: (state: WatchPartyState) => number;
  /**
   * Applies an action to the current state, returning the next state plus
   * any effects for the host to run, or `null` if the action is invalid/a
   * no-op and should be ignored entirely (no state change, no effects).
   *
   * `action` is typed as `string` rather than `WatchPartyAction` on purpose:
   * this function sits behind a wire boundary where the action name is
   * untrusted input, and any string outside the known set falls through to
   * `null` (see `default` below).
   */
  reduce: (
    state: WatchPartyState | null | undefined,
    action: string,
    payload?: WatchPartyPayload,
  ) => { state: WatchPartyState; effects: WatchPartyEffect[] } | null;
  /**
   * Normalizes state loaded from storage into a safe shape. `null` only for
   * non-object input. Playback always comes back stopped (`isPlaying:
   * false`) rather than resuming a countdown against a clock that's no
   * longer valid after a restart — same reasoning `plugin-pomodoro-state`
   * uses for its own restored `running`/`endsAt`.
   */
  restore: (raw: unknown) => WatchPartyState | null;
}

/**
 * Builds the Watch Party state API. See `CreateWatchPartyOptions` for what
 * each option controls; both are optional — omitting `pickShuffleIndex`
 * just means shuffle is inert (always FIFO), and omitting `autoAdvanceBy`
 * falls back to `'queue'`.
 *
 * Unlike `plugin-whiteboard-state`'s `createWhiteboardState`, this factory
 * has no *required* option. Whiteboard's `isOwnImageUrl` guards a genuine
 * trust boundary (which external URLs may enter shared state) that this
 * package cannot safely default. This package's `mediaUrl`/`thumbnail`
 * fields have no equivalent check here — SoundCloud permalink/artwork host
 * allowlisting is provider-specific policy this package doesn't own (its
 * provider set may grow independently), so hosts are expected to validate
 * those URLs themselves before the payload reaches `reduce`, the same way
 * they already resolve `provider` itself from trusted context.
 */
// A rejected queue add must be visible to the person who tried. Returning a
// bare `null` would make a refused add look identical to a click that did
// nothing, so every rejection the host can act on comes back as a
// `send-to-sender` effect carrying the reason (and the limit, where there is
// one) — the same shape the source this was ported from put on the wire.
function rejectQueueAdd(
  state: WatchPartyState,
  reason: string,
  limit?: number,
): WatchPartyReduceResult {
  return {
    state,
    effects: [
      {
        type: 'send-to-sender',
        message: { type: 'queue-rejected', reason, ...(limit === undefined ? {} : { limit }) },
      },
    ],
  };
}

export function createWatchParty(options: CreateWatchPartyOptions = {}): WatchPartyStateApi {
  const { pickShuffleIndex, autoAdvanceBy = 'queue' } = options;

  function reduce(
    state: WatchPartyState | null | undefined,
    action: string,
    payload?: WatchPartyPayload,
  ): { state: WatchPartyState; effects: WatchPartyEffect[] } | null {
    const s = state || defaultState();
    switch (action as WatchPartyAction) {
      case 'load-video': {
        const provider = providerOf(payload?.provider);
        const videoId = str(
          payload?.videoId,
          provider === 'soundcloud' ? MAX_SOUNDCLOUD_ID_LEN : MAX_YOUTUBE_ID_LEN,
        );
        if (!isValidMediaId(provider, videoId)) return null;
        const mediaUrl =
          provider === 'soundcloud' ? str(payload?.mediaUrl, MAX_URL_LEN) || null : null;
        if (provider === 'soundcloud' && !mediaUrl) {
          // A SoundCloud item without a resolvable media URL can never be played
          // back, and persisting it would leave the room stuck on something
          // broken after a restore. Reject it — and tell the sender why, using
          // the same reason `queue-add` reports, so a failed load is visible
          // rather than looking like the click did nothing.
          return {
            state: s,
            effects: [
              {
                type: 'send-to-sender',
                message: { type: 'queue-rejected', reason: 'invalid-media-url' },
              },
            ],
          };
        }
        const thumbnail =
          provider === 'soundcloud' && typeof payload?.thumbnail === 'string'
            ? str(payload.thumbnail, MAX_URL_LEN)
            : null;
        const title = typeof payload?.title === 'string' ? str(payload.title, MAX_TITLE_LEN) : null;
        const durationSec = sanitizeDurationSec(payload?.durationSec);
        return playNow(s, {
          videoId,
          provider,
          mediaUrl,
          thumbnail,
          title,
          durationSec,
          by: normName(payload?.by),
          byUid: normName(payload?.byUid),
        });
      }
      case 'play': {
        const parsed = parsePosition(payload?.position);
        // Falling back to `Number(x) || 0` here would rewind the whole space
        // to 0:00 on any malformed value — see `parsePosition`'s doc
        // comment. Falling back to the current (possibly extrapolated)
        // position instead means an invalid/missing position just resumes
        // playback where it already was.
        const position = parsed !== null ? parsed : currentPosition(s);
        const next = setPosition(s, position, true);
        return {
          state: next,
          effects: [
            {
              type: 'broadcast',
              message: { type: 'play', position: next.position, by: normName(payload?.by) },
              excludeSender: true,
            },
            {
              type: 'persist-playback',
              videoId: next.videoId,
              isPlaying: next.isPlaying,
              position: next.position,
            },
          ],
        };
      }
      // Intentionally empty — this is a design decision, not a stub. `pause`
      // applies only to the client that pressed it: it does not touch this
      // shared server state, and it is not broadcast to anyone else. `play`
      // and `seek` *do* affect everyone, so a naive reading suggests `pause`
      // should too, but pausing your own player to, say, answer the door
      // shouldn't stop the video for the whole space. Every other client
      // (including the pauser's own state on reconnect) simply keeps playing
      // from the shared position. Do not "fix" this into a real handler —
      // that would change synchronized playback into single-leader control.
      case 'pause':
        return null;
      case 'seek': {
        const position = parsePosition(payload?.position);
        // Unlike `play`, there's no reasonable fallback for a garbage seek
        // target — falling back to the current position would silently
        // convert a broken seek into a no-op broadcast, and falling back to
        // 0 would rewind everyone. So an invalid position is simply ignored:
        // no state change, no broadcast, no persistence.
        if (position === null) return null;
        const next = setPosition(s, position, s.isPlaying);
        return {
          state: next,
          effects: [
            {
              type: 'broadcast',
              message: {
                type: 'seek',
                position: next.position,
                isPlaying: next.isPlaying,
                by: normName(payload?.by),
              },
              excludeSender: true,
            },
            {
              type: 'persist-playback',
              videoId: next.videoId,
              isPlaying: next.isPlaying,
              position: next.position,
            },
          ],
        };
      }
      case 'video-ended': {
        // Every client that had this video loaded sends `video-ended`, so
        // only the first one whose `videoId` still matches the current item
        // is honored — this is what prevents double-advancing the queue.
        const endedId = str(payload?.videoId, MAX_SOUNDCLOUD_ID_LEN);
        if (!endedId || endedId !== s.videoId) return null;
        // Point (a) in the module's design notes: an autoplay/"mix" feature
        // is out of this package's scope, but its priority over the queue
        // must still be respected — a mix-driven space should never have
        // this package pull from the queue underneath it. Rather than
        // inject a `hasMixNext` *function* into the factory (which would go
        // stale the instant the host's mix turns on/off — it's per-space,
        // dynamic state, not a stable per-process capability like
        // `pickShuffleIndex`), the host passes a per-call flag: it already
        // knows synchronously whether its mix will handle the next item, so
        // it can decide before ever calling `reduce`. When `true`, `reduce`
        // does nothing at all (not even the freeze below) — the host's mix
        // logic owns everything from here, including what happens if it
        // turns out to have no candidate either.
        if (payload?.mixActive) return null;
        const advanced = advanceQueue(
          s,
          Boolean(payload?.shuffleEnabled),
          { by: autoAdvanceBy, byUid: null },
          pickShuffleIndex,
        );
        if (advanced) return advanced;
        // Neither a mix nor the queue has anything next. If still marked
        // playing, freeze it: stop advancing the wall-clock-extrapolated
        // position (`currentPosition`) at exactly this instant. Skipping
        // this would let a periodic sync keep broadcasting a position past
        // the end of the video, which would seek an already-ended player
        // forward and loop it back to the start.
        if (!s.isPlaying) return null; // Already frozen — nothing to do.
        const next = setPosition(s, currentPosition(s), false);
        return {
          state: next,
          effects: [
            {
              type: 'persist-playback',
              videoId: next.videoId,
              isPlaying: next.isPlaying,
              position: next.position,
            },
          ],
        };
      }
      case 'request-sync': {
        // A client resuming from the background asking to catch up
        // immediately, rather than wait for the host's periodic sync.
        if (!s.videoId) return null;
        return {
          state: s,
          effects: [
            {
              type: 'send-to-sender',
              message: { type: 'sync', position: currentPosition(s), isPlaying: s.isPlaying },
            },
          ],
        };
      }
      case 'queue-add': {
        const provider = providerOf(payload?.provider);
        const videoId = str(
          payload?.videoId,
          provider === 'soundcloud' ? MAX_SOUNDCLOUD_ID_LEN : MAX_YOUTUBE_ID_LEN,
        );
        if (!isValidMediaId(provider, videoId)) return null;
        const maxQueueLength =
          typeof payload?.maxQueueLength === 'number' ? payload.maxQueueLength : DEFAULT_MAX_QUEUE;
        if (s.queue.length >= maxQueueLength) return null;
        const addedBy = normName(payload?.addedBy);
        // Per-member queue cap. Only enforced when the host passes one (its
        // own space setting) — see the class doc comment on host-trusted
        // payload fields.
        if (typeof payload?.maxPerUser === 'number') {
          const mine = s.queue.filter((q) => q.addedBy === addedBy).length;
          if (mine >= payload.maxPerUser)
            return rejectQueueAdd(s, 'max-per-user', payload.maxPerUser);
        }
        const mediaUrl =
          provider === 'soundcloud' ? str(payload?.mediaUrl, MAX_URL_LEN) || null : null;
        if (provider === 'soundcloud' && !mediaUrl) return rejectQueueAdd(s, 'invalid-media-url');
        const thumbnail =
          provider === 'soundcloud' && typeof payload?.thumbnail === 'string'
            ? str(payload.thumbnail, MAX_URL_LEN)
            : null;
        const givenTitle =
          typeof payload?.title === 'string' && payload.title.trim()
            ? str(payload.title.trim(), MAX_TITLE_LEN)
            : null;
        const durationSec = sanitizeDurationSec(payload?.durationSec);
        // Duration-cap rejection. See point (b) in the module's design
        // notes: this package never fetches a duration itself — the host
        // resolves it (from its own cache/API) and passes both the resolved
        // `durationSec` and the cap (`maxDurationSec`, only when the cap is
        // actually enabled for this space) for `reduce` to compare. A
        // `durationSec` the host hasn't resolved yet (`null`) never gets
        // rejected here — fail-open, matching the source this was ported
        // from, since blocking on an unresolved duration would make every
        // add wait on a network round trip.
        if (
          typeof payload?.maxDurationSec === 'number' &&
          durationSec !== null &&
          durationSec > payload.maxDurationSec
        ) {
          return rejectQueueAdd(s, 'max-duration', payload.maxDurationSec);
        }
        const queueSeq = s.queueSeq + 1;
        const item: WatchPartyQueueItem = {
          uid: `q${queueSeq}`,
          videoId,
          provider,
          mediaUrl,
          thumbnail,
          title: givenTitle,
          durationSec,
          addedBy,
          addedByUid: normName(payload?.addedByUid),
          // A host that resolves metadata asynchronously (a duration lookup, a
          // title fetch) must be able to stamp arrival order *before* it
          // awaits, then hand that number in here. Assigning it at `reduce`
          // time instead would record *landing* order: two adds sent back to
          // back would swap places whenever the second one's lookup resolved
          // first, and the queue would no longer match what people sent.
          // Falls back to the internal counter when the host has no async
          // step to worry about.
          addSeq: typeof payload?.addSeq === 'number' ? payload.addSeq : queueSeq,
        };
        const queue = insertByAddSeq(s.queue, item);
        let next: WatchPartyState = { ...s, queue, queueSeq };
        const effects: WatchPartyEffect[] = [
          {
            type: 'broadcast',
            message: { type: 'queue-update', queue: stripQueueForBroadcast(next.queue) },
          },
        ];
        if (givenTitle === null) {
          effects.push({
            type: 'resolve-metadata',
            uid: item.uid,
            kind: 'queue',
            videoId,
            provider,
            mediaUrl,
            by: addedBy,
            byUid: item.addedByUid,
            durationSec,
          });
        }
        // Auto-play: nothing was playing (fresh space, or the last item
        // ended with nothing to advance to), or this add just made the
        // queue non-empty while stopped. Mirrors the source's guard exactly
        // (queue.length === 1 after the push, not "queue was empty before"
        // — so queuing several items before playback starts doesn't
        // trigger this for each one).
        if (!next.videoId || (!next.isPlaying && next.queue.length === 1)) {
          const advanced = advanceQueue(
            next,
            Boolean(payload?.shuffleEnabled),
            { by: autoAdvanceBy, byUid: null },
            pickShuffleIndex,
          );
          if (advanced) {
            next = advanced.state;
            effects.push(...advanced.effects);
          }
        }
        return { state: next, effects };
      }
      case 'queue-remove': {
        const uid = str(payload?.uid, MAX_UID_LEN);
        if (!uid) return null;
        const queue = s.queue.filter((q) => q.uid !== uid);
        if (queue.length === s.queue.length) return null; // Nothing removed → no-op.
        return {
          state: { ...s, queue },
          effects: [
            {
              type: 'broadcast',
              message: { type: 'queue-update', queue: stripQueueForBroadcast(queue) },
            },
          ],
        };
      }
      case 'queue-clear': {
        if (s.queue.length === 0) return null;
        return {
          state: { ...s, queue: [] },
          effects: [{ type: 'broadcast', message: { type: 'queue-update', queue: [] } }],
        };
      }
      case 'queue-reorder': {
        // Reordering while shuffle is on has no meaning (the play order
        // isn't the array order), so it's ignored rather than silently
        // accepted and then never honored.
        if (payload?.shuffleEnabled) return null;
        const uid = str(payload?.uid, MAX_UID_LEN);
        const from = s.queue.findIndex((q) => q.uid === uid);
        if (from === -1) return null;
        const toIndex = Math.max(
          0,
          Math.min(s.queue.length - 1, Math.trunc(Number(payload?.toIndex) || 0)),
        );
        if (from === toIndex) return null;
        const queue = s.queue.slice();
        const [item] = queue.splice(from, 1);
        queue.splice(toIndex, 0, item);
        return {
          state: { ...s, queue },
          effects: [
            {
              type: 'broadcast',
              message: { type: 'queue-update', queue: stripQueueForBroadcast(queue) },
            },
          ],
        };
      }
      case 'queue-play': {
        const uid = str(payload?.uid, MAX_UID_LEN);
        const index = s.queue.findIndex((q) => q.uid === uid);
        if (index === -1) return null;
        const item = s.queue[index];
        const queue = s.queue.filter((_, i) => i !== index);
        const { state: played, effects } = playNow(
          { ...s, queue },
          {
            videoId: item.videoId,
            provider: item.provider,
            mediaUrl: item.mediaUrl,
            thumbnail: item.thumbnail,
            title: item.title,
            durationSec: item.durationSec,
            by: normName(payload?.by),
            byUid: normName(payload?.byUid),
          },
        );
        return {
          state: played,
          effects: [
            {
              type: 'broadcast',
              message: { type: 'queue-update', queue: stripQueueForBroadcast(played.queue) },
            },
            ...effects,
          ],
        };
      }
      case 'queue-play-next': {
        return advanceQueue(
          s,
          Boolean(payload?.shuffleEnabled),
          { by: normName(payload?.by) ?? autoAdvanceBy, byUid: normName(payload?.byUid) },
          pickShuffleIndex,
        );
      }
      case 'resolve-metadata': {
        // See point (b) in the module's design notes. Applies a host-resolved
        // title/duration onto the queue or history item it was requested
        // for (correlated by `uid`, per the `resolve-metadata` effect).
        const uid = str(payload?.uid, MAX_UID_LEN);
        if (!uid) return null;
        const title =
          typeof payload?.title === 'string' ? str(payload.title, MAX_TITLE_LEN) : undefined;
        const durationSec =
          payload?.durationSec !== undefined ? sanitizeDurationSec(payload.durationSec) : undefined;
        if (title === undefined && durationSec === undefined) return null; // Nothing to apply.
        if (payload?.kind === 'history') {
          const idx = s.history.findIndex((h) => h.uid === uid);
          // Not found: the item aged out of the (capped, most-recent-first)
          // history list before the host's resolution came back. Same
          // fail-open shrug as the source's `space.history.find(...)` guard.
          if (idx === -1) return null;
          const before = s.history[idx];
          const patched: WatchPartyHistoryItem = {
            ...before,
            // Never clobber a title/duration that arrived via another path
            // in the meantime (e.g. a duplicate resolution, or the item was
            // already fully known).
            title: title !== undefined && before.title === null ? title : before.title,
            durationSec:
              durationSec !== undefined && before.durationSec === null
                ? durationSec
                : before.durationSec,
          };
          if (patched.title === before.title && patched.durationSec === before.durationSec) {
            return null;
          }
          const history = s.history.map((h, i) => (i === idx ? patched : h));
          return {
            state: { ...s, history },
            effects: [
              {
                type: 'broadcast',
                message: { type: 'history-update', history: stripHistoryForBroadcast(history) },
              },
            ],
          };
        }
        const idx = s.queue.findIndex((q) => q.uid === uid);
        // Not found: the item was already played, removed, or cleared
        // before the host's resolution came back — same fail-open shrug as
        // the source's `space.queue.includes(item)` guard.
        if (idx === -1) return null;
        const before = s.queue[idx];
        const patched: WatchPartyQueueItem = {
          ...before,
          title: title !== undefined && before.title === null ? title : before.title,
          durationSec:
            durationSec !== undefined && before.durationSec === null
              ? durationSec
              : before.durationSec,
        };
        if (patched.title === before.title && patched.durationSec === before.durationSec)
          return null;
        const queue = s.queue.map((q, i) => (i === idx ? patched : q));
        return {
          state: { ...s, queue },
          effects: [
            {
              type: 'broadcast',
              message: { type: 'queue-update', queue: stripQueueForBroadcast(queue) },
            },
          ],
        };
      }
      default:
        return null;
    }
  }

  function restore(raw: unknown): WatchPartyState | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const videoId = typeof r.videoId === 'string' && r.videoId ? r.videoId : null;
    const provider = videoId ? providerOf(r.provider) : null;
    const queueArr = Array.isArray(r.queue) ? r.queue : [];
    const queue = queueArr
      .map(sanitizeRestoredQueueItem)
      .filter((x): x is WatchPartyQueueItem => x !== null)
      .slice(0, DEFAULT_MAX_QUEUE);
    const historyArr = Array.isArray(r.history) ? r.history : [];
    const history = historyArr
      .map(sanitizeRestoredHistoryItem)
      .filter((x): x is WatchPartyHistoryItem => x !== null)
      .slice(0, MAX_HISTORY);
    const maxAddSeq = queue.reduce((max, q) => Math.max(max, q.addSeq), 0);
    const position = parsePosition(r.position) ?? 0;
    return {
      videoId,
      provider,
      mediaUrl: typeof r.mediaUrl === 'string' ? r.mediaUrl : null,
      thumbnail: typeof r.thumbnail === 'string' ? r.thumbnail : null,
      // Playback always comes back stopped — see `WatchPartyStateApi.restore`'s
      // doc comment for why (same reasoning as `plugin-pomodoro-state`).
      isPlaying: false,
      position,
      lastUpdate: Date.now(),
      queue,
      history,
      queueSeq: maxAddSeq,
      historySeq: history.length,
    };
  }

  return { defaultState, currentPosition, reduce, restore };
}

// Normalizes one persisted queue item into a safe shape, or `null` if it's
// missing the minimum required fields. Used only by `restore`.
function sanitizeRestoredQueueItem(raw: unknown): WatchPartyQueueItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const provider = providerOf(r.provider);
  const videoId = str(
    r.videoId,
    provider === 'soundcloud' ? MAX_SOUNDCLOUD_ID_LEN : MAX_YOUTUBE_ID_LEN,
  );
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
function sanitizeRestoredHistoryItem(raw: unknown, index: number): WatchPartyHistoryItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const provider = providerOf(r.provider);
  const videoId = str(
    r.videoId,
    provider === 'soundcloud' ? MAX_SOUNDCLOUD_ID_LEN : MAX_YOUTUBE_ID_LEN,
  );
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
