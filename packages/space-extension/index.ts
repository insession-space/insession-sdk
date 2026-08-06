/**
 * `@insession/space-extension` — the contract that lets a headless space be
 * assembled from a list of extensions, the way a headless editor is assembled
 * from a list of plugins.
 *
 * The design goal is that a host writes this and nothing else:
 *
 * ```ts
 * const registry = createExtensionRegistry([Chat, Pomodoro, WatchParty])
 * ```
 *
 * and gets, for free, the bookkeeping that otherwise has to be rewritten in
 * every server: which extension owns which slice of room state, how an
 * incoming action reaches the right reducer, when a timer needs (re)arming,
 * what to write to storage and how to read it back.
 *
 * ## Two properties this package deliberately keeps
 *
 * **1. The registry is open.** There is no global list of valid extension
 * names anywhere. The set of extensions is whatever was passed to
 * `createExtensionRegistry`, and each extension declares its own `name`.
 * A closed registry (a module-level `APP_IDS`-style constant that every
 * participant is validated against) works fine while the app and the list
 * ship together, but it makes an extension written by someone else
 * impossible: they cannot edit the constant, so their extension either
 * fails a startup check or gets silently dropped by settings normalization.
 *
 * **2. Every slice is namespaced.** Extension state lives at
 * `roomState[extension.name]` and nowhere else. Flattening slices onto a
 * shared room object works while the extensions are known in advance and
 * their keys are known not to collide — neither holds once extensions come
 * from outside.
 *
 * ## Zero dependencies, and no I/O
 *
 * Nothing here performs a side effect. `applyAction` returns the next state
 * plus *effect descriptors*; the host runs them against its own WebSocket
 * server and its own storage. That is what makes the same registry usable
 * from a `ws` server, a Durable Object, or a test with no network at all —
 * and it is the same discipline the state machines in this repo already
 * follow, so their existing `reduce` functions satisfy this contract as-is.
 */

// ── Effects ────────────────────────────────────────────────────────────────

/**
 * An effect the host is expected to run.
 *
 * The two message-sending shapes (`broadcast` / `send-to-sender`) are *core*:
 * they are not wrapped, so a host can handle them once and have them work for
 * every extension. They are core because they were already the shape two
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
  /** Send `message` to the room. With `excludeSender`, everyone but whoever triggered the action. */
  | { type: 'broadcast'; message: unknown; excludeSender?: boolean }
  /** Send `message` only to whoever triggered the action. */
  | { type: 'send-to-sender'; message: unknown }
  /**
   * Arm a timer for `extension` that fires in `delayMs`, replacing any timer
   * already armed for it. On firing, the host calls `applyTimer(state, extension)`.
   */
  | { type: 'schedule-timer'; extension: string; delayMs: number }
  /** Cancel the timer armed for `extension`, if any. */
  | { type: 'clear-timer'; extension: string }
  /** A domain-specific effect emitted by `extension`. Its shape is that extension's business. */
  | { type: 'extension'; extension: string; effect: unknown };

/** True for the effect shapes the registry passes through unwrapped. */
function isCoreMessageEffect(e: unknown): e is SpaceEffect {
  if (!e || typeof e !== 'object') return false;
  const t = (e as { type?: unknown }).type;
  return t === 'broadcast' || t === 'send-to-sender';
}

// ── The extension contract ─────────────────────────────────────────────────

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
  /** Unique within a registry. Also the key its slice occupies in room state. */
  name: string;
  /** Whatever the extension was configured with. The registry never reads this; it is carried for the host. */
  options?: TOptions;
  server?: ExtensionServerFacet<TState, TPayload, TEffect>;
  client?: ExtensionClientFacet;
}

/**
 * Identity function that exists for inference: it lets an extension be
 * written as an object literal and still get its facets checked, without
 * writing out a type annotation whose generics would then have to be
 * restated. Same role as `definePluginClient`.
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

// ── Registry ───────────────────────────────────────────────────────────────

/** Room state as the registry sees it: one namespaced slice per extension. */
export type RoomState = Record<string, unknown>;

/** What `applyAction`/`applyTimer` return when something actually happened. */
export interface RegistryResult {
  /** The whole room state, with the acting extension's slice replaced. */
  state: RoomState;
  effects: SpaceEffect[];
}

export interface CreateExtensionRegistryOptions {
  /**
   * Builds the message broadcast after an accepted action. Defaults to
   * `{ type: 'app-state', appId, state }`.
   *
   * Injected rather than fixed because the message that goes on the wire is
   * part of the host's protocol, not this package's: a host with its own
   * envelope, its own field names, or its own versioning needs to name those
   * itself. (Same reasoning as `isOwnImageUrl` in `plugin-whiteboard-state`
   * and `pickShuffleIndex` in `plugin-watch-party-state`: the piece that is
   * genuinely host-specific gets injected instead of assumed.)
   */
  buildStateMessage?: (args: {
    extension: string;
    state: unknown;
    action: string;
    payload?: unknown;
  }) => unknown;
  /**
   * Whether an accepted action automatically produces a `broadcast` of the
   * new slice. Default `true` — server-authoritative state is not worth much
   * if nobody is told it changed. Set `false` for a host that batches or
   * routes its own updates.
   */
  broadcastOnAction?: boolean;
  /** `excludeSender` on the automatic broadcast. Default `false` (echo to everyone, including the actor). */
  excludeSenderOnBroadcast?: boolean;
}

function defaultBuildStateMessage(args: { extension: string; state: unknown }): unknown {
  return { type: 'app-state', appId: args.extension, state: args.state };
}

/**
 * Splits a reduce result into `{ state, effects }`.
 *
 * A result counts as the rich form only if it carries *both* a `state` key
 * and an `effects` array. Checking just `'state' in result` would misread a
 * slice that happens to have its own `state` field, which is a plausible name
 * for a domain field ("playback state", "game state") — the two-key test
 * makes that collision essentially impossible without forcing simple
 * extensions to return an envelope they have no use for.
 */
function splitResult<TState>(result: unknown): { state: TState; effects: unknown[] } {
  if (
    result &&
    typeof result === 'object' &&
    'state' in result &&
    'effects' in result &&
    Array.isArray((result as { effects: unknown }).effects)
  ) {
    const r = result as { state: TState; effects: unknown[] };
    return { state: r.state, effects: r.effects };
  }
  return { state: result as TState, effects: [] };
}

/** Wraps an extension's own effects, passing the two core message shapes through untouched. */
function normalizeEffects(name: string, effects: unknown[]): SpaceEffect[] {
  return effects.map((e) =>
    isCoreMessageEffect(e) ? e : ({ type: 'extension', extension: name, effect: e } as SpaceEffect),
  );
}

export interface ExtensionRegistry {
  /** Registered names, in the order the extensions were given. */
  readonly names: string[];
  /** Whether `name` is registered. */
  has: (name: string) => boolean;
  /** The extension registered under `name`, or `undefined`. */
  get: (name: string) => SpaceExtension | undefined;
  /** A fresh room state: every server-participating extension's `defaultState()`, namespaced. */
  initState: () => RoomState;
  /**
   * Routes an action to `name`'s reducer.
   *
   * Returns `null` when nothing should happen: unknown extension, an
   * extension with no server facet, or a reducer that rejected the action.
   * All three are ordinary outcomes on a wire boundary, not errors — an
   * unknown name is what a client from a newer (or older, or hostile) build
   * looks like, and throwing on it would turn a stray frame into an outage.
   */
  applyAction: (
    state: RoomState,
    name: string,
    action: string,
    payload?: unknown,
  ) => RegistryResult | null;
  /** `name`'s current timer delay, or `null` if it has no timer facet or nothing pending. */
  timerDelay: (state: RoomState, name: string) => number | null;
  /** Runs `name`'s `onTimer`. Same `null` semantics as `applyAction`. */
  applyTimer: (state: RoomState, name: string) => RegistryResult | null;
  /** The room state as it should be written to storage, with session-only fields stripped. */
  persist: (state: RoomState) => RoomState;
  /**
   * Reads a stored room state back.
   *
   * Only registered names are read; a slice belonging to an extension that
   * is no longer present is left alone rather than dropped, so removing an
   * extension from the list temporarily (or running two hosts with different
   * lists) does not destroy its stored state on the next write.
   */
  restore: (raw: unknown) => RoomState;
  /**
   * The client facets in `PluginClient` shape (`{ id, initLocal, onAppState }`),
   * ready to hand to `createSpaceStore({ plugins })` from
   * `@insession/space-state`. Only extensions with a client facet appear.
   */
  clientExtensions: () => Array<{ id: string } & ExtensionClientFacet>;
}

/**
 * Builds a registry over `extensions`.
 *
 * Throws on a duplicate name — an open registry still needs its names to be
 * unique, since a name is also the storage key and the broadcast identifier,
 * and a silent last-one-wins would corrupt the loser's stored slice.
 */
export function createExtensionRegistry(
  extensions: SpaceExtension[],
  options: CreateExtensionRegistryOptions = {},
): ExtensionRegistry {
  if (!Array.isArray(extensions)) {
    throw new TypeError('createExtensionRegistry: `extensions` must be an array');
  }
  const {
    buildStateMessage = defaultBuildStateMessage,
    broadcastOnAction = true,
    excludeSenderOnBroadcast = false,
  } = options;

  const byName = new Map<string, SpaceExtension>();
  for (const ext of extensions) {
    if (!ext || typeof ext.name !== 'string' || ext.name === '') {
      throw new TypeError(
        'createExtensionRegistry: every extension needs a non-empty string `name`',
      );
    }
    if (byName.has(ext.name)) {
      throw new TypeError(
        `createExtensionRegistry: duplicate extension name ${JSON.stringify(ext.name)}`,
      );
    }
    byName.set(ext.name, ext);
  }
  const names = [...byName.keys()];

  // Shared tail of applyAction/applyTimer: fold the new slice back into the
  // room, then append the timer effect. The timer is (re)computed from the
  // *new* slice on every accepted transition, which is the only way to keep
  // an armed timer honest — a Pomodoro that was paused and restarted has a
  // different deadline, and a relay round that ended has none at all.
  function finish(
    state: RoomState,
    ext: SpaceExtension,
    nextSlice: unknown,
    rawEffects: unknown[],
    broadcast: { action: string; payload?: unknown } | null,
  ): RegistryResult {
    const nextState: RoomState = { ...state, [ext.name]: nextSlice };
    const effects: SpaceEffect[] = [];

    // The state broadcast goes first so a client applies the new state before
    // anything the extension emitted about it.
    if (broadcast && broadcastOnAction) {
      effects.push({
        type: 'broadcast',
        message: buildStateMessage({
          extension: ext.name,
          state: nextSlice,
          action: broadcast.action,
          payload: broadcast.payload,
        }),
        ...(excludeSenderOnBroadcast ? { excludeSender: true } : {}),
      });
    }

    effects.push(...normalizeEffects(ext.name, rawEffects));

    const delay = ext.server?.timerDelay?.(nextSlice as never) ?? null;
    effects.push(
      delay === null
        ? { type: 'clear-timer', extension: ext.name }
        : { type: 'schedule-timer', extension: ext.name, delayMs: delay },
    );

    return { state: nextState, effects };
  }

  return {
    names,
    has: (name) => byName.has(name),
    get: (name) => byName.get(name),

    initState() {
      const state: RoomState = {};
      for (const ext of byName.values()) {
        if (ext.server) state[ext.name] = ext.server.defaultState();
      }
      return state;
    },

    applyAction(state, name, action, payload) {
      const ext = byName.get(name);
      if (!ext?.server) return null;
      if (typeof action !== 'string' || action === '') return null;

      const result = ext.server.reduce(state[name] as never, action, payload as never);
      if (result === null || result === undefined) return null;

      const { state: nextSlice, effects } = splitResult(result);
      return finish(state, ext, nextSlice, effects, { action, payload });
    },

    timerDelay(state, name) {
      const ext = byName.get(name);
      if (!ext?.server?.timerDelay) return null;
      const slice = state[name];
      if (slice === undefined || slice === null) return null;
      return ext.server.timerDelay(slice as never);
    },

    applyTimer(state, name) {
      const ext = byName.get(name);
      if (!ext?.server?.onTimer) return null;
      const slice = state[name];
      if (slice === undefined || slice === null) return null;

      const result = ext.server.onTimer(slice as never);
      if (result === null || result === undefined) return null;

      const { state: nextSlice, effects } = splitResult(result);
      // A timer firing is a state change like any other, so it broadcasts on
      // the same terms an action does — otherwise a Pomodoro would switch
      // phase on the server and nobody would be told.
      return finish(state, ext, nextSlice, effects, { action: 'timer' });
    },

    persist(state) {
      const out: RoomState = { ...state };
      for (const ext of byName.values()) {
        const persistState = ext.server?.persistState;
        if (!persistState) continue;
        const slice = out[ext.name];
        if (slice === undefined || slice === null) continue;
        out[ext.name] = persistState(slice as never);
      }
      return out;
    },

    restore(raw) {
      const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
      const out: RoomState = { ...source };
      for (const ext of byName.values()) {
        if (!ext.server) continue;
        const restored = ext.server.restore
          ? ext.server.restore(source[ext.name])
          : // Without a `restore`, the slice is session-only: it comes back
            // fresh rather than being trusted straight off storage.
            null;
        out[ext.name] = restored ?? ext.server.defaultState();
      }
      return out;
    },

    clientExtensions() {
      const out: Array<{ id: string } & ExtensionClientFacet> = [];
      for (const ext of byName.values()) {
        if (ext.client) out.push({ id: ext.name, ...ext.client });
      }
      return out;
    },
  };
}
