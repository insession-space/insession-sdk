// The state shape itself.

import type { WatchPartyState } from './types.ts';

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
