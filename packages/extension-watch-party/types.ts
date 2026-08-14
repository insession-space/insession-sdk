// The wire and state shapes of the Watch Party state machine.
//
// Types only — no runtime code lives here, so every other module in this
// package can import from it without creating an initialization order between
// them.

/** Which backend the "now playing" item and each queue/history item came from. */
export type WatchPartyProvider = 'youtube' | 'soundcloud' | 'podcast';

/** One item waiting to be played. */
export interface WatchPartyQueueItem {
  /** Stable id for this queue entry, used to target `queue-remove`/`queue-reorder`/`queue-play`. */
  uid: string;
  videoId: string;
  provider: WatchPartyProvider;
  /** SoundCloud's permalink URL, or the podcast episode's audio URL. `null` for YouTube (unused there). */
  mediaUrl: string | null;
  /** SoundCloud's/the podcast episode's artwork URL. `null` for YouTube (the client derives a thumbnail from `videoId`). */
  thumbnail: string | null;
  /** `null` until resolved — see the `queue-add`/`resolve-metadata` flow in the module doc. */
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
 * `extension-pomodoro`'s payload expects the host to inject `by`/`uid`
 * from the authenticated sender rather than trusting the wire for those.
 */
export interface WatchPartyPayload {
  /** `load-video`/`queue-add`: defaults to `'youtube'` if omitted/invalid. */
  provider?: unknown;
  /** `load-video`/`queue-add`: the video/track/episode id (YouTube id, SoundCloud pseudo-id, or podcast pseudo-id). */
  videoId?: unknown;
  /** `load-video`/`queue-add` (SoundCloud/podcast only): the permalink/audio URL. */
  mediaUrl?: unknown;
  /** `load-video`/`queue-add` (SoundCloud/podcast only): the artwork URL. */
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
  /**
   * `queue-remove`/`queue-reorder`/`queue-play`: the target queue item's `uid`.
   *
   * `queue-add` also accepts it, as the id to give the new item. Supply one if
   * you persist the queue under your own ids (a database primary key); omit it
   * and `reduce` mints a counter-based id, which only stays unique for a host
   * that never reloads the queue from storage.
   */
  uid?: unknown;
  /** `queue-reorder`: the destination index. */
  toIndex?: unknown;
  /**
   * `queue-play-next`/`video-ended`/`queue-add`'s auto-play branch: whether
   * the host's shuffle setting is on for this space. Host-trusted (see the
   * interface doc comment) — `reduce` never reads a space's settings itself.
   */
  shuffleEnabled?: unknown;
  /**
   * `video-ended` only: whether the host's mix/autoplay-next feature (out of
   * this package's scope — see the `video-ended` case in `reduce.ts`) will
   * take over from here. When `true`, `reduce` does nothing at all: no queue
   * advance, no freeze. See point (a) in the module's design notes.
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

export type PickShuffleIndex = (
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
 * What `reduce` returns when it accepts an action: the next state, plus the
 * effects the host must carry out (broadcast, persist, resolve metadata).
 * `reduce` returns `null` instead when the action is invalid or a no-op.
 */
export interface WatchPartyReduceResult {
  state: WatchPartyState;
  effects: WatchPartyEffect[];
}

/**
 * The API returned by `createWatchParty`.
 */
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
   * `null`.
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
   * longer valid after a restart — same reasoning `extension-pomodoro`
   * uses for its own restored `running`/`endsAt`.
   */
  restore: (raw: unknown) => WatchPartyState | null;
}
