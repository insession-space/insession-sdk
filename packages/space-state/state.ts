// The core state of a synchronized space: transport-agnostic, framework-
// agnostic, and free of any wire contract of its own. The same tree can sit
// behind `useSyncExternalStore` or behind any other UI layer.
//
// Two things are deliberately opaque here — `settings` and each extension's
// slice under `apps`. This package never reads into either; it stores and
// replaces them wholesale. Teaching a general-purpose store the settings type
// of one particular application would make every other consumer carry it.

import type { ChatLine } from './chat-lines.ts';
import type { SpaceMember } from './messages.ts';
import type { PinnedMessage } from './types.ts';

/**
 * How long a client waits before forcing an agent's live status off screen.
 *
 * ⚠ Must be **longer than the host's own run deadline**. This is only a
 * backstop for "the server's `idle` never arrived" — shortening it below the
 * server's deadline would clear the status of a run that is still going fine.
 */
export const AGENT_STATUS_TIMEOUT_MS = 40_000;

/**
 * How many finished runs to remember, so a frame that arrives after a run's
 * `idle` can be recognized as stale and dropped. Only the recent ones matter,
 * and an unbounded set would grow for as long as somebody stays in the room.
 */
export const AGENT_ENDED_RUNS_MAX = 32;

/** How many chat lines to keep. Older lines are dropped as new ones arrive. */
export const CHAT_LINES_MAX = 200;

export type SpaceState = {
  /**
   * Whether the first full state has been received — in practice, whether the
   * connection is established. Hosts use it to close an initial loading state.
   */
  connected: boolean;
  /**
   * This client's own connection id. Exposed because some extensions need to
   * compare ids to break a tie deterministically (which peer sends the offer
   * in a WebRTC handshake, for instance).
   */
  selfId: number | null;
  members: SpaceMember[];
  title: string | null;
  /** At most one at a time, decided by the server. */
  pinnedMessage: PinnedMessage | null;
  owner: unknown;
  /**
   * ⚠ Never derive this from `owner`. A perfectly ordinary space has an owner
   * whenever its creator is signed in, so using `owner` as the test would make
   * every space look permanent.
   */
  kind: 'ephemeral' | 'my_space';
  community: unknown;
  /**
   * ⚠ Deliberately opaque. The store never reads a field of this — it holds
   * and replaces the whole object. The shape of settings is part of each
   * consumer's own wire contract, so consumers cast it to their own type, and
   * supply the default through `createSpaceStore`'s `initialSettings`.
   */
  settings: Record<string, unknown>;
  communityId: unknown;
  /** Which optional server-side capabilities are available in this space. */
  features: { durationLimit: boolean };
  /** Extension state, keyed by extension/app id. Opaque to this package. */
  apps: Record<string, unknown>;
  /**
   * The latest relayed frame per extension per sender. Unlike `apps`, the
   * server never stores these — they are live, high-frequency data (a
   * whiteboard's in-progress stroke) that only matters while it is current.
   */
  appRelay: Record<string, Record<string, unknown>>;
  /**
   * Live agent run status, keyed by agent id.
   *
   * ⚠ Volatile, like `appRelay`: it appears in neither the full state nor the
   * chat history, so a client that joins late or reloads always starts empty.
   */
  agentStatuses: Record<
    string,
    { requestId: string; phase: 'thinking' | 'working'; tool?: string }
  >;
  chatLines: ChatLine[];
  /** Who is currently typing. Volatile — never stored, never restored. */
  typingUsers: string[];
  // ── Below here: values that exist only so a transition can be detected by
  //    comparing against the previous one. A reducer receives the previous
  //    state as an argument, so they belong in the state tree rather than in
  //    some mutable cell beside it.
  /**
   * Who was sharing their screen. Used *only* to tell "nobody → somebody"
   * apart from every other screen-share update, so the log line is written
   * once. The visible sharing state itself is the consumer's to hold.
   */
  screenShareSharer: { id: number; name: string } | null;
  /**
   * A private slice per extension, keyed by extension id. An extension that
   * needs its own previous value (the last Pomodoro phase, say) keeps it here.
   * This package only knows the key; the value is never inspected. Written by
   * `PluginClient.initLocal`/`onAppState` — see `plugin.ts`.
   */
  pluginLocal: Record<string, unknown>;
  /**
   * Runs already finished, so a `working` frame arriving after that run's
   * `idle` is ignored. Frames can be reordered in transit, so the receiving
   * side needs this check even though the server also stops stray work.
   * FIFO, capped at `AGENT_ENDED_RUNS_MAX`.
   */
  endedAgentRuns: string[];
  /** Source of the next chat line's `key`. See `pushChatLine`. */
  nextChatKey: number;
};

/**
 * A fresh, unconnected space.
 *
 * `initialSettings` is the consumer's default for `settings`; this package has
 * no opinion about what settings are, so there is nothing sensible to default
 * it to here. Passed in through `createSpaceStore`.
 */
export function initialSpaceState(initialSettings: Record<string, unknown> = {}): SpaceState {
  return {
    connected: false,
    selfId: null,
    members: [],
    title: null,
    pinnedMessage: null,
    owner: null,
    kind: 'ephemeral',
    community: null,
    settings: initialSettings,
    communityId: null,
    features: { durationLimit: false },
    apps: {},
    appRelay: {},
    agentStatuses: {},
    chatLines: [],
    typingUsers: [],
    screenShareSharer: null,
    pluginLocal: {},
    endedAgentRuns: [],
    nextChatKey: 0,
  };
}
