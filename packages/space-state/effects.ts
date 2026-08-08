// The side effects `reduceSpace` asks the consumer to perform.
//
// The reducer plays no sound, raises no notification, sets no timer and sends
// nothing. It returns descriptors, and the consumer interprets them. That is
// what keeps the reducer a pure function of (state, message) and testable
// without mocking any of it — the same convention `@insession/extension-*`
// uses for its own effects.

export type SpaceEffect =
  /**
   * Play one of the two sounds this package knows about. Sounds belonging to
   * a particular extension go through `plugin-sound` instead, so that the core
   * never has to learn any extension's name or its choice of sound.
   */
  | { type: 'sound'; sound: 'join' | 'chat' }
  /**
   * Somebody joined. Only the name is given: composing the sentence needs the
   * consumer's own localization, which the reducer can only do where the
   * wording is fixed.
   */
  | { type: 'notify-join'; name: string }
  /**
   * A chat message arrived. Deciding whether it mentions the reader — and
   * therefore how loudly to announce it — is left to the consumer.
   */
  | { type: 'notify-chat'; name: string; text: string }
  /** A sound belonging to one extension. The consumer maps it to an actual sound. */
  | { type: 'plugin-sound'; appId: string; sound: string }
  /** A notification belonging to one extension. */
  | { type: 'plugin-notify'; appId: string; text: string }
  /** The space's title changed; update whatever local history records it. */
  | { type: 'history-title'; title: unknown }
  /**
   * Send this message back out.
   *
   * Typed as exactly what the reducer emits rather than as an opaque payload,
   * so a consumer can read it as well as forward it. Today that is only the
   * presence re-declaration after a reconnect; anything added later widens
   * this union, which is the right place to notice it.
   */
  | { type: 'send'; message: { type: 'presence-change'; presence: 'active' | 'away' } }
  /** Start (or restart) the 3-second timer that clears one person's typing indicator. */
  | { type: 'typing-timer'; name: string }
  /**
   * Cancel that timer. Emitted when a typing indicator is removed early
   * (the person sent their message): dropping the indicator from state without
   * also cancelling the timer would leave a stray timer running in the
   * consumer.
   */
  | { type: 'typing-timer-clear'; name: string }
  /**
   * Backstop for an agent run whose `idle` never arrives: after
   * `AGENT_STATUS_TIMEOUT_MS`, clear this run's status.
   */
  | { type: 'agent-timer'; agentId: string; requestId: string }
  /** Cancel that backstop — the run reported in on its own. */
  | { type: 'agent-timer-clear'; requestId: string };
