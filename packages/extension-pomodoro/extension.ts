// This module packaged for `@insession/space`.

import { persistState, restore } from './persist.ts';
import { onTimer, reduce, timerDelay } from './reduce.ts';
import { defaultState } from './state.ts';

/** Options for `pomodoroExtension`. */
export interface PomodoroExtensionOptions {
  /**
   * The key this extension occupies in space state, and the identifier its
   * updates are broadcast under. Defaults to `'pomodoro'`.
   *
   * Overridable so a host can run two independent timers side by side, or fit
   * an existing wire protocol whose identifier differs.
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
 * The individual functions remain exported for hosts that drive them directly.
 */
export function pomodoroExtension(options: PomodoroExtensionOptions = {}) {
  return {
    name: options.name ?? 'pomodoro',
    server: { defaultState, reduce, timerDelay, onTimer, restore, persistState },
  };
}
