// Playback itself: where the position is, what "start playing this item"
// means, and how the queue advances.
//
// Everything here is shared by more than one action — `load-video`,
// `queue-play`, `queue-play-next`, `video-ended` and `queue-add`'s auto-play
// branch all end up in `playNow`. Keeping it in its own module is what stops
// those five cases in `reduce` from each growing their own slightly different
// version of "now playing".

import { MAX_HISTORY } from './sanitize.ts';
import type {
  PickShuffleIndex,
  WatchPartyEffect,
  WatchPartyHistoryItem,
  WatchPartyProvider,
  WatchPartyQueueItem,
  WatchPartyState,
} from './types.ts';

/**
 * The current playback position, extrapolated by wall clock while playing so
 * the host doesn't have to broadcast a position update every second. While
 * stopped, this is just the recorded value.
 */
export function currentPosition(state: WatchPartyState): number {
  if (!state.isPlaying) return state.position;
  return state.position + (Date.now() - state.lastUpdate) / 1000;
}

export function setPosition(
  state: WatchPartyState,
  position: number,
  isPlaying: boolean,
): WatchPartyState {
  return { ...state, position, isPlaying, lastUpdate: Date.now() };
}

// Strips fields the client has no business seeing before an item is
// broadcast (`addedByUid`/`addSeq` on queue items). This is done here, at
// the point a `broadcast` effect is constructed, rather than left to the
// host — the same way `extension-whiteboard` fully sanitizes a shape
// before handing it back, so a host can't forget the step. See point (e) in
// the module's design notes. Effects other than `broadcast` (e.g.
// `persist-playback`) are for the host's own storage, which is free to keep
// these fields.
export function stripQueueForBroadcast(
  queue: WatchPartyQueueItem[],
): Omit<WatchPartyQueueItem, 'addedByUid' | 'addSeq'>[] {
  return queue.map(({ addedByUid: _addedByUid, addSeq: _addSeq, ...rest }) => rest);
}

export function stripHistoryForBroadcast(
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
export function insertByAddSeq(
  queue: WatchPartyQueueItem[],
  item: WatchPartyQueueItem,
): WatchPartyQueueItem[] {
  const at = queue.findIndex((q) => (q.addSeq ?? -Infinity) > item.addSeq);
  if (at === -1) return [...queue, item];
  const next = queue.slice();
  next.splice(at, 0, item);
  return next;
}

export interface PlayInfo {
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
export function playNow(
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
export function advanceQueue(
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
