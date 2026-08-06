/**
 * The extension contract: what a piece of a space has to provide to be
 * assembled into one.
 *
 * An extension carries both halves of a feature — the server-authoritative
 * reducer and the client-side fold — in a single definition. Splitting them
 * across two declarations, as this started out, means the same feature is
 * named twice and can drift.
 */

/**
 * What a `reduce`/`onTimer` may return.
 *
 * Both forms are accepted because both already exist in practice: a state
 * machine with no side effects (a Pomodoro timer) has nothing to put in an
 * `effects` array and returning a bare state is the honest signature, while
 * one that broadcasts and persists (chat, Watch Party) needs both. Requiring
 * the richer form everywhere would mean rewriting the simple ones to return
 * `{ state, effects: [] }` forever.
 *
 * `null` means "this action was invalid or a no-op": no state change, no
 * effects, nothing broadcast. This matters on a wire boundary, where the
 * action name is untrusted input.
 */
export type ExtensionReduceResult<TState, TEffect> = TState | { state: TState; effects: TEffect[] };

/**
 * The server-authoritative half of an extension: pure functions over a slice
 * of room state.
 *
 * Only `defaultState` and `reduce` are required. An extension with no timers
 * omits `timerDelay`/`onTimer`; one whose state is entirely session-scoped
 * omits `restore`/`persistState`.
 */
export interface ExtensionServerFacet<TState = any, TPayload = any, TEffect = any> {
  /** The slice's initial value, used for a fresh room and as the fallback when a restore yields nothing. */
  defaultState: () => TState;
  /**
   * Applies an action to the slice.
   *
   * `action` is a `string`, not a union, on purpose: this sits behind a wire
   * boundary where the name is untrusted, and anything unrecognized should
   * fall through to `null` rather than being assumed valid by the type system.
   */
  reduce: (
    state: TState | null | undefined,
    action: string,
    payload?: TPayload,
  ) => ExtensionReduceResult<TState, TEffect> | null;
  /** Milliseconds until this slice's next scheduled event, or `null` if it isn't waiting on anything. */
  timerDelay?: (state: TState) => number | null;
  /** Called when the timer armed from `timerDelay` fires. */
  onTimer?: (state: TState) => ExtensionReduceResult<TState, TEffect> | null;
  /** Normalizes a slice read back from storage. `null` means "unusable, start from `defaultState()`". */
  restore?: (raw: unknown) => TState | null;
  /** Strips session-only fields before the slice is written to storage. */
  persistState?: (state: TState) => TState;
}

/**
 * The client half: how this extension folds a received state update into the
 * local view (log lines, sounds, notifications).
 *
 * Structurally this is `PluginClient` from `@insession/space-state` minus its
 * `id` (the name lives on the extension itself now, so it is declared once
 * rather than twice). `registry.clientExtensions()` converts back to that
 * shape, so this package stays dependency-free while remaining usable with
 * the existing store.
 */
export interface ExtensionClientFacet<TLocal = any> {
  /**
   * Records whatever this extension needs to remember about the state it
   * joined at. Record only — deciding anything here means re-deciding it on
   * every reconnect, which is how "the sound plays when you join" bugs happen.
   */
  initLocal?: (appState: any) => TLocal;
  /** Called on each state update for this extension. */
  onAppState?: (args: { local: TLocal; msg: any; ctx: any }) => {
    local?: TLocal;
    lines?: any[];
    effects?: any[];
  };
}

/** One extension: a name, and whichever halves it participates in. */
export interface SpaceExtension<TState = any, TPayload = any, TEffect = any, TOptions = unknown> {
  /** Unique within a space. Also the key its slice occupies in room state. */
  name: string;
  /** Whatever the extension was configured with. This package never reads it; it is carried for the host. */
  options?: TOptions;
  server?: ExtensionServerFacet<TState, TPayload, TEffect>;
  client?: ExtensionClientFacet;
}

/**
 * Identity function that exists for inference: it lets an extension be
 * written as an object literal and still get its facets checked, without
 * writing out a type annotation whose generics would then have to be
 * restated.
 */
export function defineSpaceExtension<
  TState = any,
  TPayload = any,
  TEffect = any,
  TOptions = unknown,
>(
  ext: SpaceExtension<TState, TPayload, TEffect, TOptions>,
): SpaceExtension<TState, TPayload, TEffect, TOptions> {
  if (!ext || typeof ext.name !== 'string' || ext.name === '') {
    throw new TypeError('defineSpaceExtension: `name` is required and must be a non-empty string');
  }
  return ext;
}
