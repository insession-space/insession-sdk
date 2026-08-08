// This module packaged for `@insession/space`.

import { createWhiteboardState } from './reduce.ts';

/** Options for `whiteboardExtension`. Everything `createWhiteboardState` takes, plus a name. */
export interface WhiteboardExtensionOptions {
  /** See `createWhiteboardState`. Required for the same reason it is required there. */
  isOwnImageUrl: (url: string) => boolean;
  /**
   * The key this extension occupies in space state, and the identifier its
   * updates are broadcast under. Defaults to `'whiteboard'`.
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
export function whiteboardExtension(options: WhiteboardExtensionOptions) {
  return {
    name: options?.name ?? 'whiteboard',
    // Passed through rather than spread, so the missing-predicate check in
    // `createWhiteboardState` stays the single place that guards it.
    server: createWhiteboardState({ isOwnImageUrl: options?.isOwnImageUrl }),
  };
}
