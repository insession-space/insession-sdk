// The state shape itself.

import type { WhiteboardState } from './types.ts';

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
