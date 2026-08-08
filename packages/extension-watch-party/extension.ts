// This module packaged for `@insession/space`.

import { createWatchParty } from './reduce.ts';
import type { CreateWatchPartyOptions } from './types.ts';

/** Options for `watchPartyExtension`. Everything `createWatchParty` takes, plus a name. */
export interface WatchPartyExtensionOptions extends CreateWatchPartyOptions {
  /**
   * The key this extension occupies in space state, and the identifier its
   * updates are broadcast under. Defaults to `'watch-party'`.
   */
  name?: string;
}

/**
 * This module packaged as a space extension, ready to hand to
 * `createSpace({ extensions: [...] })` from `@insession/space`.
 *
 * Nothing is imported to build it: the returned object satisfies that
 * package's `SpaceExtension` *structurally*, so this package keeps its zero
 * dependencies and stays perfectly usable without `@insession/space` at all.
 */
export function watchPartyExtension(options: WatchPartyExtensionOptions = {}) {
  const { name = 'watch-party', ...rest } = options;
  return { name, server: createWatchParty(rest) };
}
