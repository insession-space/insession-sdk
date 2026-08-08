// This module packaged for `@insession/space`.

import { createChatState } from './reduce.ts';
import type { CreateChatStateOptions } from './types.ts';

/** Options for `chatExtension`. Everything `createChatState` takes, plus a name. */
export interface ChatExtensionOptions extends CreateChatStateOptions {
  /**
   * The key this extension occupies in space state, and the identifier its
   * updates are broadcast under. Defaults to `'chat'`.
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
export function chatExtension(options: ChatExtensionOptions = {}) {
  const { name = 'chat', ...rest } = options;
  return { name, server: createChatState(rest) };
}
