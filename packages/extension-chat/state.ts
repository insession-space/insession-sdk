// The in-memory state, which is one field. See the storage-model note at the
// top of `index.ts` for why there isn't more.

import type { ChatState } from './types.ts';

/** A fresh, empty space: nothing pinned. */
export function defaultState(): ChatState {
  return { pinnedMessage: null };
}
