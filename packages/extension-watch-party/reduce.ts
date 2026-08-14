// The action boundary: what an incoming action does to playback, the queue
// and the history, which effects the host has to run, and how state comes
// back from storage.

import {
  advanceQueue,
  currentPosition,
  insertByAddSeq,
  playNow,
  setPosition,
  stripHistoryForBroadcast,
  stripQueueForBroadcast,
} from './playback.ts';
import {
  DEFAULT_MAX_QUEUE,
  isExternalMediaProvider,
  isValidMediaId,
  MAX_HISTORY,
  MAX_SOUNDCLOUD_ID_LEN,
  MAX_TITLE_LEN,
  MAX_UID_LEN,
  MAX_URL_LEN,
  mediaIdMaxLen,
  normName,
  parsePosition,
  providerOf,
  sanitizeDurationSec,
  sanitizeRestoredHistoryItem,
  sanitizeRestoredQueueItem,
  str,
} from './sanitize.ts';
import { defaultState } from './state.ts';
import type {
  CreateWatchPartyOptions,
  WatchPartyAction,
  WatchPartyEffect,
  WatchPartyHistoryItem,
  WatchPartyPayload,
  WatchPartyQueueItem,
  WatchPartyReduceResult,
  WatchPartyState,
  WatchPartyStateApi,
} from './types.ts';

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

/**
 * Builds the Watch Party state API. See `CreateWatchPartyOptions` for what
 * each option controls; both are optional — omitting `pickShuffleIndex`
 * just means shuffle is inert (always FIFO), and omitting `autoAdvanceBy`
 * falls back to `'queue'`.
 *
 * Unlike `extension-whiteboard`'s `createWhiteboardState`, this factory
 * has no *required* option. Whiteboard's `isOwnImageUrl` guards a genuine
 * trust boundary (which external URLs may enter shared state) that this
 * package cannot safely default. This package's `mediaUrl`/`thumbnail`
 * fields have no equivalent check here — SoundCloud permalink/artwork host
 * allowlisting is provider-specific policy this package doesn't own (its
 * provider set may grow independently), so hosts are expected to validate
 * those URLs themselves before the payload reaches `reduce`, the same way
 * they already resolve `provider` itself from trusted context.
 */
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
        const videoId = str(payload?.videoId, mediaIdMaxLen(provider));
        if (!isValidMediaId(provider, videoId)) return null;
        const mediaUrl = isExternalMediaProvider(provider)
          ? str(payload?.mediaUrl, MAX_URL_LEN) || null
          : null;
        if (isExternalMediaProvider(provider) && !mediaUrl) {
          // A SoundCloud/podcast item without a resolvable media URL can never
          // be played back, and persisting it would leave the room stuck on
          // something broken after a restore. Reject it — and tell the sender
          // why, using the same reason `queue-add` reports, so a failed load
          // is visible rather than looking like the click did nothing.
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
          isExternalMediaProvider(provider) && typeof payload?.thumbnail === 'string'
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
        const videoId = str(payload?.videoId, mediaIdMaxLen(provider));
        if (!isValidMediaId(provider, videoId)) return null;
        const maxQueueLength =
          typeof payload?.maxQueueLength === 'number' ? payload.maxQueueLength : DEFAULT_MAX_QUEUE;
        if (s.queue.length >= maxQueueLength) return null;
        const addedBy = normName(payload?.addedBy);
        // Per-member queue cap. Only enforced when the host passes one (its
        // own space setting) — see the doc comment on host-trusted payload
        // fields.
        if (typeof payload?.maxPerUser === 'number') {
          const mine = s.queue.filter((q) => q.addedBy === addedBy).length;
          if (mine >= payload.maxPerUser)
            return rejectQueueAdd(s, 'max-per-user', payload.maxPerUser);
        }
        const mediaUrl = isExternalMediaProvider(provider)
          ? str(payload?.mediaUrl, MAX_URL_LEN) || null
          : null;
        if (isExternalMediaProvider(provider) && !mediaUrl)
          return rejectQueueAdd(s, 'invalid-media-url');
        const thumbnail =
          isExternalMediaProvider(provider) && typeof payload?.thumbnail === 'string'
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
          // A host that persists its queue almost certainly has its own id for
          // each row — a database primary key it later uses to delete or
          // reorder. Let it supply that id so the two never drift apart.
          // The built-in counter is only safe for a host that keeps the whole
          // queue in memory: it restarts from zero on reload, so persisted
          // rows from an earlier run would collide with freshly minted ids.
          uid: str(payload?.uid, MAX_UID_LEN) || `q${queueSeq}`,
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
      // doc comment for why (same reasoning as `extension-pomodoro`).
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
