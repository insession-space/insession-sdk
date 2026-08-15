// Run with: node --test packages/extension-watch-party

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  createWatchParty,
  currentPosition,
  defaultState,
  type WatchPartyEffect,
  type WatchPartyState,
} from './index.ts';

// Every test that depends on Date.now() replaces it for the duration of the
// test and restores it afterwards, so timing is deterministic.
function withFrozenClock<T>(nowMs: number, fn: () => T): T {
  const orig = Date.now;
  Date.now = () => nowMs;
  try {
    return fn();
  } finally {
    Date.now = orig;
  }
}

const NOW = 1_700_000_000_000;

const wp = createWatchParty();

function effectsOf(result: { effects: WatchPartyEffect[] } | null): WatchPartyEffect[] {
  return result?.effects ?? [];
}

function findBroadcast(effects: WatchPartyEffect[], type: string): any {
  const found = effects.find((e) => e.type === 'broadcast' && (e.message as any)?.type === type) as
    | { message: any }
    | undefined;
  return found?.message;
}

// --- currentPosition -------------------------------------------------------

test('currentPosition: extrapolates while playing, returns the recorded value while stopped', () => {
  const playing: WatchPartyState = {
    ...defaultState(),
    isPlaying: true,
    position: 10,
    lastUpdate: NOW,
  };
  const pos = withFrozenClock(NOW + 5_000, () => currentPosition(playing));
  assert.equal(pos, 15);

  const stopped: WatchPartyState = {
    ...defaultState(),
    isPlaying: false,
    position: 42,
    lastUpdate: NOW,
  };
  assert.equal(
    withFrozenClock(NOW + 5_000, () => currentPosition(stopped)),
    42,
  );
});

// --- load-video -------------------------------------------------------------

test('load-video: rejects an invalid videoId', () => {
  assert.equal(wp.reduce(defaultState(), 'load-video', { videoId: 'short' }), null);
  assert.equal(wp.reduce(defaultState(), 'load-video', {}), null);
});

test('load-video: accepts a valid YouTube id and resets position to 0/playing', () => {
  const result = withFrozenClock(NOW, () =>
    wp.reduce(defaultState(), 'load-video', { videoId: 'dQw4w9WgXcQ', by: 'alice' }),
  );
  assert.ok(result);
  assert.equal(result?.state.videoId, 'dQw4w9WgXcQ');
  assert.equal(result?.state.provider, 'youtube');
  assert.equal(result?.state.isPlaying, true);
  assert.equal(result?.state.position, 0);
  assert.equal(result?.state.history.length, 1);
  assert.equal(result?.state.history[0]?.videoId, 'dQw4w9WgXcQ');
  const loadMsg = findBroadcast(effectsOf(result), 'load-video');
  assert.ok(loadMsg);
  assert.equal(loadMsg.by, 'alice');
});

test('load-video: unknown title emits a resolve-metadata effect for the history entry', () => {
  const result = wp.reduce(defaultState(), 'load-video', { videoId: 'dQw4w9WgXcQ' });
  const resolve = effectsOf(result).find((e) => e.type === 'resolve-metadata');
  assert.ok(resolve);
  assert.equal((resolve as any).kind, 'history');
});

test('load-video: known title skips the resolve-metadata effect', () => {
  const result = wp.reduce(defaultState(), 'load-video', {
    videoId: 'dQw4w9WgXcQ',
    title: 'Never Gonna',
  });
  const resolve = effectsOf(result).find((e) => e.type === 'resolve-metadata');
  assert.equal(resolve, undefined);
  assert.equal(result?.state.history[0]?.title, 'Never Gonna');
});

test('load-video: soundcloud without a mediaUrl is rejected', () => {
  // ⚠ `defaultState()` stamps `lastUpdate: Date.now()`, so it must be built once
  // and compared against itself. Calling it a second time inside the assertion
  // makes this test fail whenever a millisecond ticks in between — rare locally,
  // routine on a slow CI runner. Reusing the instance also states the intent
  // more precisely: the state is *unchanged*, not merely default-shaped.
  const initial = defaultState();
  const out = wp.reduce(initial, 'load-video', {
    provider: 'soundcloud',
    videoId: 'sc-track-abc',
  });
  // Rejected, but not silently: nothing enters state and the sender is told why.
  assert.ok(out);
  assert.deepEqual(out.state, initial);
  assert.deepEqual(out.effects, [
    { type: 'send-to-sender', message: { type: 'queue-rejected', reason: 'invalid-media-url' } },
  ]);
});

test('load-video: soundcloud with a mediaUrl is accepted', () => {
  const result = wp.reduce(defaultState(), 'load-video', {
    provider: 'soundcloud',
    videoId: 'sc-track-abc',
    mediaUrl: 'https://soundcloud.com/artist/track',
  });
  assert.ok(result);
  assert.equal(result?.state.provider, 'soundcloud');
  assert.equal(result?.state.mediaUrl, 'https://soundcloud.com/artist/track');
});

// A `providerOf`/`isValidMediaId` regression the app hit in the wild (#2039):
// before podcast support existed here, an unrecognized `provider` string fell
// through to the YouTube branch, so a podcast episode id (which never matches
// YouTube's 11-char `[\w-]` shape) was silently rejected as an invalid
// videoId — no error, no `queue-rejected`, just nothing happening.
test('load-video: podcast without a mediaUrl is rejected', () => {
  const initial = defaultState();
  const out = wp.reduce(initial, 'load-video', {
    provider: 'podcast',
    videoId: 'podcast-0a1b2c3d-4e5f6a7b',
  });
  // Rejected, but not silently: nothing enters state and the sender is told why.
  assert.ok(out);
  assert.deepEqual(out.state, initial);
  assert.deepEqual(out.effects, [
    { type: 'send-to-sender', message: { type: 'queue-rejected', reason: 'invalid-media-url' } },
  ]);
});

test('load-video: podcast with a mediaUrl is accepted', () => {
  const result = wp.reduce(defaultState(), 'load-video', {
    provider: 'podcast',
    videoId: 'podcast-0a1b2c3d-4e5f6a7b',
    mediaUrl: 'https://example.com/episode.mp3',
    thumbnail: 'https://example.com/episode.jpg',
  });
  assert.ok(result);
  assert.equal(result?.state.provider, 'podcast');
  assert.equal(result?.state.videoId, 'podcast-0a1b2c3d-4e5f6a7b');
  assert.equal(result?.state.mediaUrl, 'https://example.com/episode.mp3');
  assert.equal(result?.state.thumbnail, 'https://example.com/episode.jpg');
});

// The same `providerOf`/`isValidMediaId` regression, hit again for Spotify: the
// consuming app added a `spotify` provider on its side only, so this module fell
// through to the YouTube branch and rejected every `spotify-episode-<id>` as an
// invalid videoId. The client showed "added to queue" while the queue stayed
// empty — the exact silent failure the podcast tests above were written for.
test('load-video: spotify with a mediaUrl is accepted', () => {
  const result = wp.reduce(defaultState(), 'load-video', {
    provider: 'spotify',
    videoId: 'spotify-episode-5SIS7xmznPY2CKDoTXYNmc',
    mediaUrl: 'https://open.spotify.com/episode/5SIS7xmznPY2CKDoTXYNmc',
    thumbnail: 'https://image-cdn-ak.spotifycdn.com/image/abc123',
  });
  assert.ok(result);
  assert.equal(result?.state.provider, 'spotify');
  assert.equal(result?.state.videoId, 'spotify-episode-5SIS7xmznPY2CKDoTXYNmc');
  assert.equal(result?.state.mediaUrl, 'https://open.spotify.com/episode/5SIS7xmznPY2CKDoTXYNmc');
});

test('load-video: rejects a spotify id in the wrong shape', () => {
  // Spotify ids are base62 and exactly 22 chars; anything else is not one.
  assert.equal(
    wp.reduce(defaultState(), 'load-video', {
      provider: 'spotify',
      videoId: 'spotify-episode-tooshort',
      mediaUrl: 'https://open.spotify.com/episode/tooshort',
    }),
    null,
  );
});

test('queue-add: spotify keeps its mediaUrl through sanitization', () => {
  // `isExternalMediaProvider` gates whether `mediaUrl` survives; without spotify
  // in it the host loses the episode URL it needs for display/outbound links.
  // Something must already be playing, otherwise `queue-add` auto-plays the item
  // and pops it straight back off the queue (see the auto-play tests below).
  const state: WatchPartyState = { ...defaultState(), videoId: 'dQw4w9WgXcQ', isPlaying: true };
  const result = wp.reduce(state, 'queue-add', {
    provider: 'spotify',
    videoId: 'spotify-episode-5SIS7xmznPY2CKDoTXYNmc',
    mediaUrl: 'https://open.spotify.com/episode/5SIS7xmznPY2CKDoTXYNmc',
    title: 'An episode',
  });
  assert.ok(result);
  const added = result?.state.queue.at(-1);
  assert.equal(added?.provider, 'spotify');
  assert.equal(added?.mediaUrl, 'https://open.spotify.com/episode/5SIS7xmznPY2CKDoTXYNmc');
});

test('load-video: rejects a podcast id in the wrong shape (e.g. a bare YouTube-length id)', () => {
  assert.equal(
    wp.reduce(defaultState(), 'load-video', {
      provider: 'podcast',
      videoId: 'notarealpo',
      mediaUrl: 'https://example.com/episode.mp3',
    }),
    null,
  );
});

// --- play / pause / seek -----------------------------------------------------

test('play: invalid/missing position keeps the current (extrapolated) position but sets isPlaying true', () => {
  const stopped: WatchPartyState = {
    ...defaultState(),
    isPlaying: false,
    position: 30,
    lastUpdate: NOW,
  };
  const result = withFrozenClock(NOW + 2_000, () => wp.reduce(stopped, 'play', {}));
  assert.ok(result);
  assert.equal(result?.state.isPlaying, true);
  assert.equal(result?.state.position, 30); // stopped, so currentPosition === position (no extrapolation)
});

test('play: valid position is honored', () => {
  const result = wp.reduce(defaultState(), 'play', { position: 12.5 });
  assert.ok(result);
  assert.equal(result?.state.position, 12.5);
  assert.equal(result?.state.isPlaying, true);
  const msg = findBroadcast(effectsOf(result), 'play');
  assert.equal(msg.position, 12.5);
});

test('play: broadcast excludes the sender', () => {
  const result = wp.reduce(defaultState(), 'play', {});
  const broadcast = effectsOf(result).find((e) => e.type === 'broadcast');
  assert.equal((broadcast as any).excludeSender, true);
});

test('pause: always a no-op — no state change, no effects', () => {
  const state: WatchPartyState = { ...defaultState(), isPlaying: true, position: 5 };
  assert.equal(wp.reduce(state, 'pause', {}), null);
  assert.equal(wp.reduce(defaultState(), 'pause', { position: 99 }), null);
});

test('seek: invalid position does nothing (no state change, no effects)', () => {
  assert.equal(wp.reduce(defaultState(), 'seek', {}), null);
  assert.equal(wp.reduce(defaultState(), 'seek', { position: -5 }), null);
  assert.equal(wp.reduce(defaultState(), 'seek', { position: 'nope' }), null);
  assert.equal(wp.reduce(defaultState(), 'seek', { position: NaN }), null);
});

test('seek: valid position updates state and preserves isPlaying', () => {
  const playing: WatchPartyState = { ...defaultState(), isPlaying: true };
  const result = wp.reduce(playing, 'seek', { position: 77 });
  assert.ok(result);
  assert.equal(result?.state.position, 77);
  assert.equal(result?.state.isPlaying, true);
  const msg = findBroadcast(effectsOf(result), 'seek');
  assert.equal(msg.position, 77);
  assert.equal(msg.isPlaying, true);
});

// --- video-ended --------------------------------------------------------

test('video-ended: only the first report matching the current videoId is honored', () => {
  const state: WatchPartyState = { ...defaultState(), videoId: 'dQw4w9WgXcQ', isPlaying: true };
  // A different (stale) videoId is ignored.
  assert.equal(wp.reduce(state, 'video-ended', { videoId: 'someOtherId' }), null);
});

test('video-ended: advances the queue when one is available', () => {
  const state: WatchPartyState = {
    ...defaultState(),
    videoId: 'dQw4w9WgXcQ',
    isPlaying: true,
    queue: [
      {
        uid: 'q1',
        videoId: 'aaaaaaaaaaa',
        provider: 'youtube',
        mediaUrl: null,
        thumbnail: null,
        title: 'Next One',
        durationSec: null,
        addedBy: 'bob',
        addedByUid: 'uid-bob',
        addSeq: 1,
      },
    ],
  };
  const result = wp.reduce(state, 'video-ended', { videoId: 'dQw4w9WgXcQ' });
  assert.ok(result);
  assert.equal(result?.state.videoId, 'aaaaaaaaaaa');
  assert.equal(result?.state.queue.length, 0);
  // Advanced automatically -> by defaults to the auto-advance sentinel.
  const loadMsg = findBroadcast(effectsOf(result), 'load-video');
  assert.equal(loadMsg.by, 'queue');
});

test('video-ended: mixActive short-circuits entirely (no state change, no effects, no queue touch)', () => {
  const state: WatchPartyState = {
    ...defaultState(),
    videoId: 'dQw4w9WgXcQ',
    isPlaying: true,
    queue: [
      {
        uid: 'q1',
        videoId: 'aaaaaaaaaaa',
        provider: 'youtube',
        mediaUrl: null,
        thumbnail: null,
        title: 'Next One',
        durationSec: null,
        addedBy: null,
        addedByUid: null,
        addSeq: 1,
      },
    ],
  };
  assert.equal(wp.reduce(state, 'video-ended', { videoId: 'dQw4w9WgXcQ', mixActive: true }), null);
});

test('video-ended: no queue and not a mix freezes isPlaying and locks in the position', () => {
  const state: WatchPartyState = {
    ...defaultState(),
    videoId: 'dQw4w9WgXcQ',
    isPlaying: true,
    position: 100,
    lastUpdate: NOW,
  };
  const result = withFrozenClock(NOW + 3_000, () =>
    wp.reduce(state, 'video-ended', { videoId: 'dQw4w9WgXcQ' }),
  );
  assert.ok(result);
  assert.equal(result?.state.isPlaying, false);
  assert.equal(result?.state.position, 103); // extrapolated position at the moment of freeze
  const persist = effectsOf(result).find((e) => e.type === 'persist-playback');
  assert.ok(persist);
});

test('video-ended: already frozen (not playing) with an empty queue is a true no-op', () => {
  const state: WatchPartyState = { ...defaultState(), videoId: 'dQw4w9WgXcQ', isPlaying: false };
  assert.equal(wp.reduce(state, 'video-ended', { videoId: 'dQw4w9WgXcQ' }), null);
});

// --- request-sync ---------------------------------------------------------

test('request-sync: no videoId is a no-op', () => {
  assert.equal(wp.reduce(defaultState(), 'request-sync', {}), null);
});

test('request-sync: sends the current position/isPlaying only to the sender', () => {
  const state: WatchPartyState = {
    ...defaultState(),
    videoId: 'dQw4w9WgXcQ',
    isPlaying: true,
    position: 10,
    lastUpdate: NOW,
  };
  const result = withFrozenClock(NOW + 1_000, () => wp.reduce(state, 'request-sync', {}));
  assert.ok(result);
  assert.equal(result?.state, state); // unchanged
  const effects = effectsOf(result);
  assert.equal(effects.length, 1);
  assert.equal(effects[0]?.type, 'send-to-sender');
  assert.equal((effects[0] as any).message.position, 11);
});

// --- queue-add --------------------------------------------------------------

test('queue-add: rejects an invalid videoId', () => {
  assert.equal(wp.reduce(defaultState(), 'queue-add', { videoId: 'x' }), null);
});

test('queue-add: adds to the queue, bumps addSeq, and does not auto-play when already playing', () => {
  const state: WatchPartyState = { ...defaultState(), videoId: 'dQw4w9WgXcQ', isPlaying: true };
  const result = wp.reduce(state, 'queue-add', { videoId: 'aaaaaaaaaaa', addedBy: 'alice' });
  assert.ok(result);
  assert.equal(result?.state.queue.length, 1);
  assert.equal(result?.state.queue[0]?.videoId, 'aaaaaaaaaaa');
  assert.equal(result?.state.queue[0]?.addSeq, 1);
  assert.equal(result?.state.videoId, 'dQw4w9WgXcQ'); // unchanged — did not auto-play
});

test('queue-add: auto-plays when nothing was loaded yet', () => {
  const result = wp.reduce(defaultState(), 'queue-add', {
    videoId: 'aaaaaaaaaaa',
    addedBy: 'alice',
  });
  assert.ok(result);
  assert.equal(result?.state.videoId, 'aaaaaaaaaaa');
  assert.equal(result?.state.queue.length, 0); // popped straight back off
});

test('queue-add: auto-plays when stopped and this is the only queued item', () => {
  const state: WatchPartyState = {
    ...defaultState(),
    videoId: 'dQw4w9WgXcQ',
    isPlaying: false,
  };
  const result = wp.reduce(state, 'queue-add', { videoId: 'aaaaaaaaaaa' });
  assert.ok(result);
  assert.equal(result?.state.videoId, 'aaaaaaaaaaa');
});

test('queue-add: over the max queue length rejects', () => {
  let s: WatchPartyState = defaultState();
  for (let i = 0; i < 50; i++) {
    const added = wp.reduce({ ...s, videoId: 'dQw4w9WgXcQ', isPlaying: true }, 'queue-add', {
      videoId: 'aaaaaaaaaaa',
    });
    assert.ok(added);
    s = added.state;
  }
  assert.equal(s.queue.length, 50);
  assert.equal(
    wp.reduce({ ...s, videoId: 'dQw4w9WgXcQ', isPlaying: true }, 'queue-add', {
      videoId: 'bbbbbbbbbbb',
    }),
    null,
  );
});

test('queue-add: custom maxQueueLength is honored', () => {
  const state: WatchPartyState = {
    ...defaultState(),
    videoId: 'dQw4w9WgXcQ',
    isPlaying: true,
    queue: [
      {
        uid: 'q1',
        videoId: 'aaaaaaaaaaa',
        provider: 'youtube',
        mediaUrl: null,
        thumbnail: null,
        title: null,
        durationSec: null,
        addedBy: null,
        addedByUid: null,
        addSeq: 1,
      },
    ],
  };
  assert.equal(wp.reduce(state, 'queue-add', { videoId: 'bbbbbbbbbbb', maxQueueLength: 1 }), null);
});

test('queue-add: maxPerUser rejects once the same adder hits the cap', () => {
  const state: WatchPartyState = {
    ...defaultState(),
    videoId: 'dQw4w9WgXcQ',
    isPlaying: true,
    queue: [
      {
        uid: 'q1',
        videoId: 'aaaaaaaaaaa',
        provider: 'youtube',
        mediaUrl: null,
        thumbnail: null,
        title: null,
        durationSec: null,
        addedBy: 'alice',
        addedByUid: null,
        addSeq: 1,
      },
    ],
  };
  // 拒否は握り潰さず、理由と上限を送信者へ返す（移植元と同じ形）。
  const capped = wp.reduce(state, 'queue-add', {
    videoId: 'bbbbbbbbbbb',
    addedBy: 'alice',
    maxPerUser: 1,
  });
  assert.ok(capped);
  assert.equal(capped.state.queue.length, 1, '積まれていない');
  assert.deepEqual(capped.effects, [
    {
      type: 'send-to-sender',
      message: { type: 'queue-rejected', reason: 'max-per-user', limit: 1 },
    },
  ]);
  assert.ok(
    wp.reduce(state, 'queue-add', { videoId: 'bbbbbbbbbbb', addedBy: 'carol', maxPerUser: 1 }),
  );
});

test('queue-add: maxDurationSec rejects an over-limit resolved duration, but null duration fails open', () => {
  const state: WatchPartyState = { ...defaultState(), videoId: 'dQw4w9WgXcQ', isPlaying: true };
  const tooLong = wp.reduce(state, 'queue-add', {
    videoId: 'aaaaaaaaaaa',
    durationSec: 700,
    maxDurationSec: 600,
  });
  assert.ok(tooLong);
  assert.equal(tooLong.state.queue.length, 0, '積まれていない');
  assert.deepEqual(tooLong.effects, [
    {
      type: 'send-to-sender',
      message: { type: 'queue-rejected', reason: 'max-duration', limit: 600 },
    },
  ]);
  const ok = wp.reduce(state, 'queue-add', { videoId: 'aaaaaaaaaaa', maxDurationSec: 600 }); // unresolved
  assert.ok(ok);
});

test('queue-add: unknown title emits a resolve-metadata effect for the queue item', () => {
  const state: WatchPartyState = { ...defaultState(), videoId: 'dQw4w9WgXcQ', isPlaying: true };
  const result = wp.reduce(state, 'queue-add', { videoId: 'aaaaaaaaaaa' });
  const resolve = effectsOf(result).find((e) => e.type === 'resolve-metadata');
  assert.ok(resolve);
  assert.equal((resolve as any).kind, 'queue');
});

test('insertByAddSeq (via queue-add): items without addSeq sort to the front', () => {
  const restored: WatchPartyState = {
    ...defaultState(),
    videoId: 'dQw4w9WgXcQ',
    isPlaying: true,
    queue: [
      {
        uid: 'restored-1',
        videoId: 'aaaaaaaaaaa',
        provider: 'youtube',
        mediaUrl: null,
        thumbnail: null,
        title: null,
        durationSec: null,
        addedBy: null,
        addedByUid: null,
        addSeq: undefined as unknown as number, // simulate a legacy row with no addSeq
      },
    ],
  };
  const result = wp.reduce(restored, 'queue-add', { videoId: 'bbbbbbbbbbb' });
  assert.ok(result);
  assert.deepEqual(
    result?.state.queue.map((q) => q.videoId),
    ['aaaaaaaaaaa', 'bbbbbbbbbbb'],
  );
});

// --- queue-remove / queue-clear / queue-reorder / queue-play / queue-play-next ---

function withQueue(items: Array<{ uid: string; videoId: string }>): WatchPartyState {
  return {
    ...defaultState(),
    videoId: 'dQw4w9WgXcQ',
    isPlaying: true,
    queue: items.map((it, i) => ({
      uid: it.uid,
      videoId: it.videoId,
      provider: 'youtube' as const,
      mediaUrl: null,
      thumbnail: null,
      title: `title-${it.uid}`,
      durationSec: null,
      addedBy: null,
      addedByUid: null,
      addSeq: i + 1,
    })),
  };
}

test('queue-remove: removes the matching item, no-ops if not found', () => {
  const state = withQueue([
    { uid: 'q1', videoId: 'aaaaaaaaaaa' },
    { uid: 'q2', videoId: 'bbbbbbbbbbb' },
  ]);
  const result = wp.reduce(state, 'queue-remove', { uid: 'q1' });
  assert.ok(result);
  assert.deepEqual(
    result?.state.queue.map((q) => q.uid),
    ['q2'],
  );
  assert.equal(wp.reduce(state, 'queue-remove', { uid: 'ghost' }), null);
});

test('queue-clear: empties the queue, no-ops if already empty', () => {
  const state = withQueue([{ uid: 'q1', videoId: 'aaaaaaaaaaa' }]);
  const result = wp.reduce(state, 'queue-clear', {});
  assert.ok(result);
  assert.deepEqual(result?.state.queue, []);
  assert.equal(wp.reduce(defaultState(), 'queue-clear', {}), null);
});

test('queue-reorder: moves an item, ignored while shuffle is enabled', () => {
  const state = withQueue([
    { uid: 'q1', videoId: 'aaaaaaaaaaa' },
    { uid: 'q2', videoId: 'bbbbbbbbbbb' },
    { uid: 'q3', videoId: 'ccccccccccc' },
  ]);
  const result = wp.reduce(state, 'queue-reorder', { uid: 'q1', toIndex: 2 });
  assert.ok(result);
  assert.deepEqual(
    result?.state.queue.map((q) => q.uid),
    ['q2', 'q3', 'q1'],
  );
  assert.equal(
    wp.reduce(state, 'queue-reorder', { uid: 'q1', toIndex: 2, shuffleEnabled: true }),
    null,
  );
});

test('queue-play: plays the targeted item regardless of position, removes it from the queue', () => {
  const state = withQueue([
    { uid: 'q1', videoId: 'aaaaaaaaaaa' },
    { uid: 'q2', videoId: 'bbbbbbbbbbb' },
  ]);
  const result = wp.reduce(state, 'queue-play', { uid: 'q2', by: 'alice' });
  assert.ok(result);
  assert.equal(result?.state.videoId, 'bbbbbbbbbbb');
  assert.deepEqual(
    result?.state.queue.map((q) => q.uid),
    ['q1'],
  );
  const loadMsg = findBroadcast(effectsOf(result), 'load-video');
  assert.equal(loadMsg.by, 'alice');
});

test('queue-play-next: FIFO by default (index 0), no-ops on an empty queue', () => {
  const state = withQueue([
    { uid: 'q1', videoId: 'aaaaaaaaaaa' },
    { uid: 'q2', videoId: 'bbbbbbbbbbb' },
  ]);
  const result = wp.reduce(state, 'queue-play-next', { by: 'bob' });
  assert.ok(result);
  assert.equal(result?.state.videoId, 'aaaaaaaaaaa');
  const loadMsg = findBroadcast(effectsOf(result), 'load-video');
  assert.equal(loadMsg.by, 'bob');
  assert.equal(wp.reduce(defaultState(), 'queue-play-next', {}), null);
});

test('queue-play-next: shuffle uses the injected pickShuffleIndex', () => {
  const shuffled = createWatchParty({ pickShuffleIndex: () => 1 });
  const state = withQueue([
    { uid: 'q1', videoId: 'aaaaaaaaaaa' },
    { uid: 'q2', videoId: 'bbbbbbbbbbb' },
  ]);
  const result = shuffled.reduce(state, 'queue-play-next', { shuffleEnabled: true });
  assert.ok(result);
  assert.equal(result?.state.videoId, 'bbbbbbbbbbb');
  // The unpicked item remains queued.
  assert.deepEqual(
    result?.state.queue.map((q) => q.uid),
    ['q1'],
  );
});

test('queue-play-next: without pickShuffleIndex, shuffleEnabled is inert (still FIFO)', () => {
  const state = withQueue([
    { uid: 'q1', videoId: 'aaaaaaaaaaa' },
    { uid: 'q2', videoId: 'bbbbbbbbbbb' },
  ]);
  const result = wp.reduce(state, 'queue-play-next', { shuffleEnabled: true });
  assert.equal(result?.state.videoId, 'aaaaaaaaaaa');
});

test('queue-play-next: default autoAdvanceBy is "queue" when no by is given', () => {
  const state = withQueue([{ uid: 'q1', videoId: 'aaaaaaaaaaa' }]);
  const result = wp.reduce(state, 'queue-play-next', {});
  const loadMsg = findBroadcast(effectsOf(result), 'load-video');
  assert.equal(loadMsg.by, 'queue');
});

test('createWatchParty: autoAdvanceBy is configurable', () => {
  const custom = createWatchParty({ autoAdvanceBy: 'auto-dj' });
  const state = withQueue([{ uid: 'q1', videoId: 'aaaaaaaaaaa' }]);
  const result = custom.reduce(state, 'queue-play-next', {});
  const loadMsg = findBroadcast(effectsOf(result), 'load-video');
  assert.equal(loadMsg.by, 'auto-dj');
});

// --- resolve-metadata -------------------------------------------------------

test('resolve-metadata: patches a queue item by uid, no-op if not found', () => {
  const state = withQueue([{ uid: 'q1', videoId: 'aaaaaaaaaaa' }]);
  const patched: WatchPartyState = { ...state, queue: [{ ...state.queue[0], title: null }] };
  const result = wp.reduce(patched, 'resolve-metadata', { uid: 'q1', title: 'Resolved Title' });
  assert.ok(result);
  assert.equal(result?.state.queue[0]?.title, 'Resolved Title');
  assert.equal(wp.reduce(state, 'resolve-metadata', { uid: 'ghost', title: 'x' }), null);
});

test('resolve-metadata: patches a history item by uid+kind', () => {
  const state: WatchPartyState = {
    ...defaultState(),
    history: [
      {
        uid: 'h1',
        videoId: 'aaaaaaaaaaa',
        provider: 'youtube',
        mediaUrl: null,
        thumbnail: null,
        title: null,
        durationSec: null,
        by: null,
        byUid: null,
        ts: NOW,
      },
    ],
  };
  const result = wp.reduce(state, 'resolve-metadata', {
    uid: 'h1',
    kind: 'history',
    title: 'Resolved',
  });
  assert.ok(result);
  assert.equal(result?.state.history[0]?.title, 'Resolved');
});

test('resolve-metadata: does not clobber an already-known title', () => {
  const state = withQueue([{ uid: 'q1', videoId: 'aaaaaaaaaaa' }]); // title already set to 'title-q1'
  assert.equal(wp.reduce(state, 'resolve-metadata', { uid: 'q1', title: 'Different' }), null);
});

test('resolve-metadata: no title/duration provided is a no-op', () => {
  const state = withQueue([{ uid: 'q1', videoId: 'aaaaaaaaaaa' }]);
  assert.equal(wp.reduce(state, 'resolve-metadata', { uid: 'q1' }), null);
});

// --- broadcast stripping (point (e)) ---------------------------------------

test('queue-update broadcasts never carry addedByUid/addSeq', () => {
  const state: WatchPartyState = { ...defaultState(), videoId: 'dQw4w9WgXcQ', isPlaying: true };
  const result = wp.reduce(state, 'queue-add', {
    videoId: 'aaaaaaaaaaa',
    addedBy: 'alice',
    addedByUid: 'uid-alice',
  });
  const msg = findBroadcast(effectsOf(result), 'queue-update');
  assert.ok(msg);
  for (const item of msg.queue) {
    assert.equal('addedByUid' in item, false);
    assert.equal('addSeq' in item, false);
  }
});

test('history-update broadcasts never carry byUid', () => {
  const result = wp.reduce(defaultState(), 'load-video', {
    videoId: 'dQw4w9WgXcQ',
    byUid: 'uid-alice',
  });
  const msg = findBroadcast(effectsOf(result), 'history-update');
  assert.ok(msg);
  for (const item of msg.history) {
    assert.equal('byUid' in item, false);
  }
});

// --- restore ------------------------------------------------------------

test('restore: null/string/number input returns null', () => {
  assert.equal(wp.restore(null), null);
  assert.equal(wp.restore('nope'), null);
  assert.equal(wp.restore(42), null);
});

test('restore: always comes back stopped even if the input says playing', () => {
  const next = wp.restore({ videoId: 'dQw4w9WgXcQ', isPlaying: true, position: 55 });
  assert.ok(next);
  assert.equal(next?.isPlaying, false);
  assert.equal(next?.position, 55);
  assert.equal(next?.videoId, 'dQw4w9WgXcQ');
  assert.equal(next?.provider, 'youtube');
});

test('restore: no videoId means no provider either', () => {
  const next = wp.restore({});
  assert.ok(next);
  assert.equal(next?.videoId, null);
  assert.equal(next?.provider, null);
});

test('restore: filters malformed queue/history entries and keeps valid ones', () => {
  const next = wp.restore({
    queue: [
      { uid: 'q1', videoId: 'aaaaaaaaaaa', addSeq: 3 },
      { uid: 'bad', videoId: 'nope' },
      null,
      {},
    ],
    history: [
      { uid: 'h1', videoId: 'bbbbbbbbbbb', ts: NOW },
      { uid: 'bad', videoId: 'x' },
    ],
  });
  assert.ok(next);
  assert.deepEqual(
    next?.queue.map((q) => q.uid),
    ['q1'],
  );
  assert.deepEqual(
    next?.history.map((h) => h.uid),
    ['h1'],
  );
  assert.equal(next?.queueSeq, 3); // picked up from the surviving item's addSeq
});

test('restore: array input is typeof "object" so it degrades to a safe empty state, not null', () => {
  const next = wp.restore([1, 2, 3]);
  assert.ok(next);
  assert.deepEqual(next?.queue, []);
  assert.deepEqual(next?.history, []);
});

test('restore: caps queue/history at their max lengths', () => {
  const queue = Array.from({ length: 60 }, (_, i) => ({
    uid: `q${i}`,
    videoId: 'aaaaaaaaaaa',
    addSeq: i,
  }));
  const history = Array.from({ length: 60 }, (_, i) => ({
    uid: `h${i}`,
    videoId: 'aaaaaaaaaaa',
    ts: NOW + i,
  }));
  const next = wp.restore({ queue, history });
  assert.ok(next);
  assert.equal(next?.queue.length, 50);
  assert.equal(next?.history.length, 50);
});

test('restore: negative/invalid position clamps to 0', () => {
  assert.equal(wp.restore({ position: -5 })?.position, 0);
  assert.equal(wp.restore({ position: 'nope' })?.position, 0);
});

// --- unknown action / null-state fallback -----------------------------------

test('unknown action returns null', () => {
  assert.equal(wp.reduce(defaultState(), 'not-a-real-action'), null);
});

test('reduce falls back to defaultState() when given null/undefined state', () => {
  const result = wp.reduce(null, 'load-video', { videoId: 'dQw4w9WgXcQ' });
  assert.ok(result);
  assert.equal(result?.state.videoId, 'dQw4w9WgXcQ');
});

// --- factory instances are independent --------------------------------------

test('two createWatchParty() instances do not share pickShuffleIndex/autoAdvanceBy', () => {
  const a = createWatchParty({ pickShuffleIndex: () => 0, autoAdvanceBy: 'a' });
  const b = createWatchParty({ pickShuffleIndex: () => 0, autoAdvanceBy: 'b' });
  const state = withQueue([{ uid: 'q1', videoId: 'aaaaaaaaaaa' }]);
  const resultA = a.reduce(state, 'queue-play-next', {});
  const resultB = b.reduce(state, 'queue-play-next', {});
  assert.equal(findBroadcast(effectsOf(resultA), 'load-video').by, 'a');
  assert.equal(findBroadcast(effectsOf(resultB), 'load-video').by, 'b');
});

// This package is published for browsers as well as servers, so it must not
// reach for Node-only globals. `Buffer` was used in an earlier plugin-state
// package's byte cap and threw `ReferenceError: Buffer is not defined` in a
// browser the moment it ran — a failure no Node-side test could ever catch.
test('does not depend on Node-only globals (browser-safe)', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
    // Strip comments first: this file *documents* why Node-only globals are
    // avoided, and that prose must not trip the check that no code uses them.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  for (const nodeOnly of ['Buffer.', 'process.env', 'require(', '__dirname']) {
    assert.ok(
      !source.includes(nodeOnly),
      `index.ts must not use the Node-only global \`${nodeOnly}\` — this package runs in browsers too`,
    );
  }
});

// A SoundCloud load without a resolvable media URL must tell the sender why.
// Returning a bare `null` here would leave the click looking like a no-op, and
// the source this was ported from does report it.
test('load-video: rejecting a SoundCloud item without a media URL notifies the sender', () => {
  const wp = createWatchParty();
  // Same reason as the other rejection test above: build the baseline once and
  // compare against that instance, or `lastUpdate`'s `Date.now()` makes this flaky.
  const initial = wp.defaultState();
  const out = wp.reduce(initial, 'load-video', {
    provider: 'soundcloud',
    videoId: 'sc-track-some/slug',
  });
  assert.ok(out, 'the rejection must be reported, not swallowed');
  assert.deepEqual(out.state, initial, 'nothing broken enters state');
  assert.deepEqual(out.effects, [
    { type: 'send-to-sender', message: { type: 'queue-rejected', reason: 'invalid-media-url' } },
  ]);
});

// Every rejection the source reported on the wire must still be reported.
// Collapsing these into a bare `null` would make a refused add look exactly
// like a click that did nothing.
test('queue-add: each rejection tells the sender why', () => {
  const wp = createWatchParty();
  const base = wp.defaultState();
  // ⚠ 何も再生していない state への queue-add は「即再生」になりキューに積まれない。
  // 上限の検証には、先に再生中の state を作っておく必要がある。
  const playing = wp.reduce(base, 'load-video', { videoId: 'zyxwvutsrqp', by: 'alice' })!.state;
  const add = (state: WatchPartyState, extra: Record<string, unknown>) =>
    wp.reduce(state, 'queue-add', { videoId: 'abcdefghijk', addedBy: 'alice', ...extra });

  // per-member cap
  const first = add(playing, { maxPerUser: 1 });
  assert.ok(first);
  const overCap = add(first.state, { maxPerUser: 1 });
  assert.ok(overCap);
  assert.deepEqual(overCap.effects, [
    {
      type: 'send-to-sender',
      message: { type: 'queue-rejected', reason: 'max-per-user', limit: 1 },
    },
  ]);
  assert.equal(overCap.state.queue.length, 1, 'nothing was added');

  // duration cap
  const tooLong = add(playing, { durationSec: 9999, maxDurationSec: 600 });
  assert.ok(tooLong);
  assert.deepEqual(tooLong.effects, [
    {
      type: 'send-to-sender',
      message: { type: 'queue-rejected', reason: 'max-duration', limit: 600 },
    },
  ]);

  // SoundCloud without a media URL
  const broken = wp.reduce(playing, 'queue-add', {
    provider: 'soundcloud',
    videoId: 'sc-track-abc',
    addedBy: 'alice',
  });
  assert.ok(broken);
  assert.deepEqual(broken.effects, [
    { type: 'send-to-sender', message: { type: 'queue-rejected', reason: 'invalid-media-url' } },
  ]);

  // Podcast without a media URL — same rejection path (#2039 regression).
  const brokenPodcast = wp.reduce(playing, 'queue-add', {
    provider: 'podcast',
    videoId: 'podcast-0a1b2c3d-4e5f6a7b',
    addedBy: 'alice',
  });
  assert.ok(brokenPodcast);
  assert.deepEqual(brokenPodcast.effects, [
    { type: 'send-to-sender', message: { type: 'queue-rejected', reason: 'invalid-media-url' } },
  ]);
});

// #2039: a podcast episode must be able to go all the way through `queue-add`
// — accepted into the queue, broadcast, and (since nothing was playing)
// auto-played — the same as a YouTube/SoundCloud item. Before podcast support
// existed here, `isValidMediaId` always tested podcast pseudo-ids against
// YouTube's 11-char regex, so this add would have silently returned `null`.
test('queue-add: a podcast episode is accepted into the queue and auto-plays', () => {
  const wp = createWatchParty();
  const result = wp.reduce(wp.defaultState(), 'queue-add', {
    provider: 'podcast',
    videoId: 'podcast-0a1b2c3d-4e5f6a7b',
    mediaUrl: 'https://example.com/episode.mp3',
    thumbnail: 'https://example.com/episode.jpg',
    title: 'Episode 1',
    durationSec: 1800,
    addedBy: 'alice',
  });
  assert.ok(result, 'the podcast episode must not be silently rejected');
  // Nothing was playing, so `queue-add` auto-advances into it immediately —
  // it never lands in the queue array itself.
  assert.equal(result.state.queue.length, 0);
  assert.equal(result.state.videoId, 'podcast-0a1b2c3d-4e5f6a7b');
  assert.equal(result.state.provider, 'podcast');
  assert.equal(result.state.mediaUrl, 'https://example.com/episode.mp3');
  assert.equal(result.state.thumbnail, 'https://example.com/episode.jpg');
  assert.equal(result.state.isPlaying, true);
  assert.equal(result.state.history[0]?.videoId, 'podcast-0a1b2c3d-4e5f6a7b');
  assert.equal(result.state.history[0]?.provider, 'podcast');

  const queueUpdate = findBroadcast(effectsOf(result), 'queue-update');
  assert.ok(queueUpdate, 'queue-add must broadcast a queue-update even when it immediately drains');
  const loadMsg = findBroadcast(effectsOf(result), 'load-video');
  assert.ok(loadMsg, 'auto-play must broadcast load-video for the podcast episode');
});

// A second podcast episode added while one is already playing must land (and
// stay) in the queue rather than auto-playing over the current one.
test('queue-add: a second podcast episode queues behind the one already playing', () => {
  const wp = createWatchParty();
  const playing = wp.reduce(wp.defaultState(), 'queue-add', {
    provider: 'podcast',
    videoId: 'podcast-0a1b2c3d-4e5f6a7b',
    mediaUrl: 'https://example.com/episode-1.mp3',
    addedBy: 'alice',
  })!.state;
  const result = wp.reduce(playing, 'queue-add', {
    provider: 'podcast',
    videoId: 'podcast-11111111-22222222',
    mediaUrl: 'https://example.com/episode-2.mp3',
    addedBy: 'alice',
  });
  assert.ok(result);
  assert.equal(result.state.queue.length, 1);
  assert.equal(result.state.queue[0]?.videoId, 'podcast-11111111-22222222');
  assert.equal(result.state.queue[0]?.provider, 'podcast');
  assert.equal(result.state.queue[0]?.mediaUrl, 'https://example.com/episode-2.mp3');
  // The currently-playing episode is untouched.
  assert.equal(result.state.videoId, 'podcast-0a1b2c3d-4e5f6a7b');
});

// A host that awaits before calling `reduce` must be able to stamp arrival
// order itself. Without this, two adds sent back to back swap places whenever
// the second one's metadata lookup resolves first.
test('queue-add: a host-supplied addSeq preserves send order over landing order', () => {
  const wp = createWatchParty();
  const playing = wp.reduce(wp.defaultState(), 'load-video', {
    videoId: 'zyxwvutsrqp',
    by: 'alice',
  })!.state;

  // "Sent first, landed second" — arrival stamps 1 and 2, applied in the order 2 then 1.
  const second = wp.reduce(playing, 'queue-add', {
    videoId: 'bbbbbbbbbbb',
    addedBy: 'alice',
    addSeq: 2,
  });
  assert.ok(second);
  const first = wp.reduce(second.state, 'queue-add', {
    videoId: 'aaaaaaaaaaa',
    addedBy: 'alice',
    addSeq: 1,
  });
  assert.ok(first);
  assert.deepEqual(
    first.state.queue.map((q) => q.videoId),
    ['aaaaaaaaaaa', 'bbbbbbbbbbb'],
    'the earlier-sent item slots in ahead of the one that landed first',
  );

  // Omitting addSeq keeps the previous behaviour (assigned at call time).
  const noStamp = wp.reduce(playing, 'queue-add', { videoId: 'ccccccccccc', addedBy: 'alice' });
  assert.ok(noStamp);
  assert.equal(typeof noStamp.state.queue[0].addSeq, 'number');
});

// A host that persists its queue has its own row ids. Minting our own would
// drift from theirs — and the built-in counter restarts at zero on reload, so
// a restored queue would collide with freshly added items.
test('queue-add: a host-supplied uid is used as the item id', () => {
  const wp = createWatchParty();
  const playing = wp.reduce(wp.defaultState(), 'load-video', {
    videoId: 'zyxwvutsrqp',
    by: 'alice',
  })!.state;

  const added = wp.reduce(playing, 'queue-add', {
    videoId: 'aaaaaaaaaaa',
    addedBy: 'alice',
    uid: 'db-row-7f3a',
  });
  assert.ok(added);
  assert.equal(added.state.queue[0].uid, 'db-row-7f3a');

  // ...and that id is what the other queue actions target.
  const removed = wp.reduce(added.state, 'queue-remove', { uid: 'db-row-7f3a' });
  assert.ok(removed);
  assert.equal(removed.state.queue.length, 0);

  // Omitting it keeps the counter-based fallback.
  const auto = wp.reduce(playing, 'queue-add', { videoId: 'bbbbbbbbbbb', addedBy: 'alice' });
  assert.ok(auto);
  assert.match(auto.state.queue[0].uid, /^q\d+$/);
});
