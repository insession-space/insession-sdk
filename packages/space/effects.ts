/**
 * Everything this package asks a host to do, described rather than done.
 *
 * No function in this package opens a socket, writes to storage, or calls
 * `setTimeout`. They return effect descriptors and the host runs them, which
 * is what lets the same space run on a `ws` server, a Durable Object, or a
 * test with no network at all.
 */

/**
 * An effect the host is expected to run.
 *
 * The two message-sending shapes (`broadcast` / `send-to-sender`) are *core*:
 * they are not wrapped, so a host handles them once and they work for every
 * extension. They are core because they were already the shape two
 * independently-written state machines in this repo converged on, which is
 * about as good evidence as one gets that they are the universal cases.
 *
 * Everything else an extension emits is domain-specific (persisting playback
 * position, resolving a title, notifying bots, ...). Those pass through
 * wrapped in `{ type: 'extension', extension, effect }` so the host can tell
 * *whose* effect it is without extensions having to agree on a shared
 * vocabulary — and so two extensions can each have an effect named
 * `'persist'` without colliding.
 */
export type SpaceEffect =
  /** Send `message` to everyone in the space. With `excludeSender`, everyone but whoever triggered the action. */
  | { type: 'broadcast'; message: unknown; excludeSender?: boolean }
  /** Send `message` only to whoever triggered the action. */
  | { type: 'send-to-sender'; message: unknown }
  /**
   * Arm a timer for `extension` that fires in `delayMs`, replacing any timer
   * already armed for it. On firing, the host calls `fireTimer(extension)`.
   */
  | { type: 'schedule-timer'; extension: string; delayMs: number }
  /** Cancel the timer armed for `extension`, if any. */
  | { type: 'clear-timer'; extension: string }
  /** A domain-specific effect emitted by `extension`. Its shape is that extension's business. */
  | { type: 'extension'; extension: string; effect: unknown };

/** True for the effect shapes that pass through unwrapped. */
export function isCoreMessageEffect(e: unknown): e is SpaceEffect {
  if (!e || typeof e !== 'object') return false;
  const t = (e as { type?: unknown }).type;
  return t === 'broadcast' || t === 'send-to-sender';
}

/** Wraps an extension's own effects, passing the two core message shapes through untouched. */
export function tagExtensionEffects(name: string, effects: unknown[]): SpaceEffect[] {
  return effects.map((e) =>
    isCoreMessageEffect(e) ? e : ({ type: 'extension', extension: name, effect: e } as SpaceEffect),
  );
}
