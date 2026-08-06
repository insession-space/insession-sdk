/**
 * The extension registry: the bookkeeping that has to exist once there is
 * more than one extension, and that no single extension can do for itself
 * because it does not know who else is present.
 *
 * ## Two properties this deliberately keeps
 *
 * **1. The registry is open.** There is no global list of valid extension
 * names anywhere. The set of extensions is whatever was passed in, and each
 * extension declares its own `name`. A closed registry (a module-level
 * `APP_IDS`-style constant that every participant is validated against) works
 * fine while the app and the list ship together, but it makes an extension
 * written by someone else impossible: they cannot edit the constant, so their
 * extension either fails a startup check or gets silently dropped by settings
 * normalization.
 *
 * **2. Every slice is namespaced.** Extension state lives at
 * `extensionState[extension.name]` and nowhere else. Flattening slices onto a
 * shared space object works while the extensions are known in advance and
 * their keys are known not to collide — neither holds once extensions come
 * from outside.
 */
import { type SpaceEffect, tagExtensionEffects } from '../effects.ts';
import type { SpaceExtension } from './contract.ts';

/** The extension half of a space's state: one namespaced slice per extension. */
export type ExtensionState = Record<string, unknown>;

/** What an accepted transition produces. */
export interface RegistryResult {
  /** All slices, with the acting extension's replaced. */
  state: ExtensionState;
  effects: SpaceEffect[];
}

export interface ExtensionRegistryOptions {
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

export interface ExtensionRegistry {
  /** Registered names, in the order the extensions were given. */
  readonly names: string[];
  /** Whether `name` is registered. */
  has: (name: string) => boolean;
  /** The extension registered under `name`, or `undefined`. */
  get: (name: string) => SpaceExtension | undefined;
  /** A fresh set of slices: every server-participating extension's `defaultState()`. */
  initState: () => ExtensionState;
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
    state: ExtensionState,
    name: string,
    action: string,
    payload?: unknown,
  ) => RegistryResult | null;
  /** `name`'s current timer delay, or `null` if it has no timer facet or nothing pending. */
  timerDelay: (state: ExtensionState, name: string) => number | null;
  /** Runs `name`'s `onTimer`. Same `null` semantics as `applyAction`. */
  applyTimer: (state: ExtensionState, name: string) => RegistryResult | null;
  /** The slices as they should be written to storage, with session-only fields stripped. */
  persist: (state: ExtensionState) => ExtensionState;
  /**
   * Reads stored slices back.
   *
   * Only registered names are read; a slice belonging to an extension that
   * is no longer present is left alone rather than dropped, so removing an
   * extension from the list temporarily (or running two hosts with different
   * lists) does not destroy its stored state on the next write.
   */
  restore: (raw: unknown) => ExtensionState;
  /**
   * The client facets in `PluginClient` shape (`{ id, initLocal, onAppState }`),
   * ready to hand to `createSpaceStore({ plugins })` from
   * `@insession/space-state`. Only extensions with a client facet appear.
   */
  clientExtensions: () => Array<{ id: string } & NonNullable<SpaceExtension['client']>>;
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
  options: ExtensionRegistryOptions = {},
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

  // Shared tail of applyAction/applyTimer: fold the new slice back in, then
  // append the timer effect. The timer is (re)computed from the *new* slice on
  // every accepted transition, which is the only way to keep an armed timer
  // honest — a Pomodoro that was paused and restarted has a different
  // deadline, and a relay round that ended has none at all.
  function finish(
    state: ExtensionState,
    ext: SpaceExtension,
    nextSlice: unknown,
    rawEffects: unknown[],
    broadcast: { action: string; payload?: unknown },
  ): RegistryResult {
    const nextState: ExtensionState = { ...state, [ext.name]: nextSlice };
    const effects: SpaceEffect[] = [];

    // The state broadcast goes first so a client applies the new state before
    // anything the extension emitted about it.
    if (broadcastOnAction) {
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

    effects.push(...tagExtensionEffects(ext.name, rawEffects));

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
      const state: ExtensionState = {};
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
      const out: ExtensionState = { ...state };
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
      const out: ExtensionState = { ...source };
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
      const out: Array<{ id: string } & NonNullable<SpaceExtension['client']>> = [];
      for (const ext of byName.values()) {
        if (ext.client) out.push({ id: ext.name, ...ext.client });
      }
      return out;
    },
  };
}
