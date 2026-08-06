/**
 * `createSpace` — the instance a host drives.
 *
 * This is the ergonomic layer over the pure pieces (`createExtensionRegistry`
 * and the functions in `room.ts`): it owns the room state so a host does not
 * have to thread it through every call, and every method returns the effects
 * to run.
 *
 * The pure layer stays exported. A host that wants to own the state itself —
 * to keep it in a database row, to snapshot it per revision, to run it inside
 * something that already has its own state discipline — can use those
 * directly and ignore this file.
 */
import type { SpaceEffect } from './effects.ts';
import type { SpaceExtension } from './extension.ts';
import {
  createExtensionRegistry,
  type ExtensionRegistryOptions,
  type ExtensionState,
} from './registry.ts';
import {
  addConnection,
  dedupeByUid,
  findMember,
  hasConnection,
  isFirstConnectionOfUid,
  isLastConnectionOfUid,
  type RoomState,
  removeConnection,
  type SpaceMember,
  setPresence,
} from './room.ts';

/** What `join` needs to know about the arriving connection. `presence` defaults to `'active'`. */
export interface JoinInput {
  connId: string;
  name: string;
  uid?: string | null;
  presence?: 'active' | 'away';
}

export interface CreateSpaceOptions extends ExtensionRegistryOptions {
  extensions: SpaceExtension[];
  /**
   * Builds the snapshot sent to a connection that just joined. Defaults to
   * `{ type: 'space-state', selfId, members, extensions }`.
   *
   * Injected for the same reason as `buildStateMessage`: the envelope on the
   * wire is the host's protocol, not this package's.
   */
  buildSyncMessage?: (args: {
    self: SpaceMember;
    members: SpaceMember[];
    extensions: ExtensionState;
  }) => unknown;
  /** Defaults to `{ type: 'member-joined', member, members }`. */
  buildJoinMessage?: (args: { member: SpaceMember; members: SpaceMember[] }) => unknown;
  /** Defaults to `{ type: 'member-left', member, members }`. */
  buildLeaveMessage?: (args: { member: SpaceMember; members: SpaceMember[] }) => unknown;
  /** Defaults to `{ type: 'member-updated', member, members }`. */
  buildPresenceMessage?: (args: { member: SpaceMember; members: SpaceMember[] }) => unknown;
}

export interface Space {
  /** The whole room. Treated as immutable — every transition replaces it. */
  getState: () => RoomState;
  /** Live connections, one entry per socket. */
  members: () => SpaceMember[];
  /** One entry per person: the same account on two devices counts once. */
  people: () => SpaceMember[];
  /** No connections left. What a host checks before disposing the room. */
  isEmpty: () => boolean;

  /**
   * Adds a connection.
   *
   * Always replies to the arriving connection with a full snapshot, and
   * announces the arrival to the room *only* when this is the person's first
   * connection — a second device is not a second arrival.
   */
  join: (input: JoinInput) => SpaceEffect[];
  /**
   * Removes a connection. Announces a departure only when it was the
   * person's last one. An unknown `connId` is a no-op returning no effects,
   * so a duplicate disconnect is harmless.
   */
  leave: (connId: string) => SpaceEffect[];
  /** Changes one connection's presence. A no-op change produces no effects. */
  setPresence: (connId: string, presence: 'active' | 'away') => SpaceEffect[];

  /**
   * Routes an action to an extension.
   *
   * Returns an empty array when nothing happened — unknown extension, no
   * server facet, or a rejected action — because on a wire boundary all three
   * are ordinary, not errors.
   *
   * Anything the reducer should be able to trust (who sent it, whether an
   * upload was validated) belongs in `payload`, put there by the host from
   * authenticated context rather than taken from the client's frame.
   */
  dispatch: (extension: string, action: string, payload?: unknown) => SpaceEffect[];
  /** Runs an extension's `onTimer`, in response to a `schedule-timer` effect firing. */
  fireTimer: (extension: string) => SpaceEffect[];
  /**
   * The `schedule-timer`/`clear-timer` effects for every extension, derived
   * from current state. Used after `hydrate` to re-arm what a restart dropped.
   */
  armTimers: () => SpaceEffect[];

  /** The extension slices as they should be written to storage. */
  snapshot: () => ExtensionState;
  /** Replaces the extension slices from storage. Does not touch members. */
  hydrate: (raw: unknown) => void;

  /** Client facets in `PluginClient` shape, for `@insession/space-state`. */
  clientExtensions: () => ReturnType<
    ReturnType<typeof createExtensionRegistry>['clientExtensions']
  >;
}

export function createSpace(options: CreateSpaceOptions): Space {
  const {
    extensions,
    buildSyncMessage = ({ self, members, extensions: ext }) => ({
      type: 'space-state',
      selfId: self.connId,
      members,
      extensions: ext,
    }),
    buildJoinMessage = ({ member, members }) => ({ type: 'member-joined', member, members }),
    buildLeaveMessage = ({ member, members }) => ({ type: 'member-left', member, members }),
    buildPresenceMessage = ({ member, members }) => ({ type: 'member-updated', member, members }),
    ...registryOptions
  } = options;

  const registry = createExtensionRegistry(extensions, registryOptions);
  let state: RoomState = { members: [], extensions: registry.initState() };

  return {
    getState: () => state,
    members: () => state.members,
    people: () => dedupeByUid(state.members),
    isEmpty: () => state.members.length === 0,

    join(input) {
      const member: SpaceMember = {
        connId: input.connId,
        name: input.name,
        uid: input.uid ?? null,
        presence: input.presence ?? 'active',
      };
      // Asked before the member is added: afterwards they are always present
      // and every arrival would look like a second device.
      const first = isFirstConnectionOfUid(state.members, member);
      const rejoin = hasConnection(state.members, member.connId);
      state = { ...state, members: addConnection(state.members, member) };

      const effects: SpaceEffect[] = [
        {
          type: 'send-to-sender',
          message: buildSyncMessage({
            self: member,
            members: state.members,
            extensions: state.extensions,
          }),
        },
      ];
      // A re-join on a connection that is already here is a correction, not
      // an arrival — announcing it would put the same person in the room log
      // twice.
      if (first && !rejoin) {
        effects.push({
          type: 'broadcast',
          message: buildJoinMessage({ member, members: state.members }),
          excludeSender: true,
        });
      }
      return effects;
    },

    leave(connId) {
      const member = findMember(state.members, connId);
      if (!member) return [];
      const last = isLastConnectionOfUid(state.members, connId);
      state = { ...state, members: removeConnection(state.members, connId) };
      if (!last) return [];
      return [
        { type: 'broadcast', message: buildLeaveMessage({ member, members: state.members }) },
      ];
    },

    setPresence(connId, presence) {
      const members = setPresence(state.members, connId, presence);
      if (members === state.members) return [];
      state = { ...state, members };
      const member = findMember(members, connId);
      if (!member) return [];
      return [{ type: 'broadcast', message: buildPresenceMessage({ member, members }) }];
    },

    dispatch(extension, action, payload) {
      const result = registry.applyAction(state.extensions, extension, action, payload);
      if (!result) return [];
      state = { ...state, extensions: result.state };
      return result.effects;
    },

    fireTimer(extension) {
      const result = registry.applyTimer(state.extensions, extension);
      if (!result) return [];
      state = { ...state, extensions: result.state };
      return result.effects;
    },

    armTimers() {
      return registry.names.map((name) => {
        const delay = registry.timerDelay(state.extensions, name);
        return delay === null
          ? ({ type: 'clear-timer', extension: name } as SpaceEffect)
          : ({ type: 'schedule-timer', extension: name, delayMs: delay } as SpaceEffect);
      });
    },

    snapshot: () => registry.persist(state.extensions),

    hydrate(raw) {
      state = { ...state, extensions: registry.restore(raw) };
    },

    clientExtensions: () => registry.clientExtensions(),
  };
}
