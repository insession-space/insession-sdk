// The messages this store consumes, written down as types.
//
// `reduceSpace` used to take `msg: any`, which meant the wire contract this
// package depends on existed only in the reducer's switch — you had to read
// every case to learn what a host has to send. These declarations are that
// contract, made readable in one place.
//
// **Each variant lists only the fields the reducer actually reads.** A host's
// real messages usually carry more (its own envelope, ids, timestamps), so
// every variant also allows unknown extra keys — the same way an extension's
// payload type does in `@insession/extension-*`. Nothing here is validated at
// runtime: these are a description of what the reducer expects, not a gate
// that rejects anything else. A host that speaks a different protocol is
// expected to translate into these shapes before calling `receive`.

import type { ChatReactionSummary, HostFields, PinnedMessage } from './types.ts';

/**
 * Any message at all, as long as it says what it is.
 *
 * `reduceSpace` accepts this alongside `SpaceMessage` so that a host can put
 * its own messages through the same channel — they fall through to the
 * reducer's `default` case and change nothing. It is also what makes a message
 * assembled at runtime (where `type` widens to `string`) callable without a
 * cast at every call site.
 */
export interface UnknownSpaceMessage extends HostFields {
  type: string;
}

/**
 * One connection in the space.
 *
 * A signed-in person may occupy several of these at once (one per device);
 * `uid` is what ties them together. See `presence.ts` for why the server
 * keeps them separate rather than merging them itself.
 */
export interface SpaceMember extends HostFields {
  /** Per-connection id, unique within the space. Compare with `selfId`. */
  id: number;
  name: string;
  /** Stable user id, or absent/null for a guest. */
  uid?: string | null;
  presence?: 'active' | 'away';
  /** Which card the member currently has open, if the host tracks that. */
  currentStage?: string | null;
}

/** A chat message as it arrives from the server, or is replayed from history. */
export interface ServerChatMessage extends HostFields {
  name: string;
  text: string;
  /** Storage id. `null`/absent when the host has no storage. */
  id?: number | null;
  uid?: string | null;
  /**
   * Resolved by the server at send time rather than looked up from the member
   * list, so a message still shows the right avatar once its sender has left.
   */
  avatar?: string | null;
  /** `'sticker'` and `'agent'` are the two kinds the reducer branches on. */
  kind?: string;
  /** Sticker messages only. */
  imageUrl?: string;
  replyTo?: { id: number; name: string; text: string } | null;
  reactions?: ChatReactionSummary;
  /** Which agent spoke, when `kind` is `'agent'`. Used to resolve its avatar. */
  agentId?: string | null;
  /**
   * Options an agent offers alongside its message. Deliberately absent from
   * replayed history — they are not stored, so old proposals never come back.
   */
  choices?: unknown;
  createdAt?: number;
}

/** The whole space, sent on join and on every reconnect. */
export interface SpaceStateMessage extends HostFields {
  type: 'space-state';
  selfId?: number | null;
  members: SpaceMember[];
  title?: string | null;
  pinnedMessage?: PinnedMessage | null;
  owner?: unknown;
  kind?: string;
  community?: unknown;
  /** Opaque to this package — see `SpaceState.settings`. */
  settings?: Record<string, unknown>;
  communityId?: unknown;
  features?: { durationLimit: boolean };
  /** Extension state, keyed by extension/app id. */
  apps?: Record<string, unknown>;
  screenShareSharer?: { id: number; name: string } | null;
}

/** Someone else joined. The server excludes the joiner from delivery. */
export interface MemberJoinedMessage extends HostFields {
  type: 'member-joined';
  member: SpaceMember;
  members: SpaceMember[];
  /**
   * `true` when this join is a reconnect after a server restart rather than a
   * person arriving. Announced joins are suppressed for these.
   */
  resumed?: boolean;
}

export interface MemberLeftMessage extends HostFields {
  type: 'member-left';
  members: SpaceMember[];
}

/** One member changed; the member list itself is not resent. */
export interface MemberUpdatedMessage extends HostFields {
  type: 'member-updated';
  member: SpaceMember;
}

/** The owner was decided while everyone stayed in the room. */
export interface SpaceOwnerUpdatedMessage extends HostFields {
  type: 'space-owner-updated';
  owner?: unknown;
}

/** The join was refused. Recovery is the consumer's call — see the reducer. */
export interface JoinRejectedMessage extends HostFields {
  type: 'join-rejected';
}

export interface ScreenShareStateMessage extends HostFields {
  type: 'screen-share-state';
  sharer?: { id: number; name: string } | null;
}

/** Somebody favorited a queued item on this member's behalf. */
export interface FavoriteQueuedVideoMessage extends HostFields {
  type: 'favorite-queued-video';
  /** Only the member whose `uid` matches is told. */
  targetUid: string;
  by: string;
}

export interface ChatMessage extends ServerChatMessage {
  type: 'chat';
}

export interface ChatHistoryMessage extends HostFields {
  type: 'chat-history';
  messages: ServerChatMessage[];
}

/** The server's receipt for a message this client sent optimistically. */
export interface ChatAckMessage extends HostFields {
  type: 'chat-ack';
  clientMsgId: string;
  id?: number | null;
  /** The authoritative send time, so every client shows the same one. */
  createdAt?: number;
}

export interface ChatReactionUpdateMessage extends HostFields {
  type: 'chat-reaction-update';
  messageId: number;
  reactions?: ChatReactionSummary;
}

export interface SpaceRenamedMessage extends HostFields {
  type: 'space-renamed';
  title?: string | null;
  by: string;
}

export interface MessagePinnedMessage extends HostFields {
  type: 'message-pinned';
  /** `null` means the pin was cleared. */
  pinned?: PinnedMessage | null;
  by: string;
}

export interface SpaceSettingsUpdatedMessage extends HostFields {
  type: 'space-settings-updated';
  settings?: Record<string, unknown>;
  by: string;
}

/** An extension's authoritative state, delivered to everyone including the sender. */
export interface AppStateMessage extends HostFields {
  type: 'app-state';
  appId: string;
  state: unknown;
  /**
   * Which action produced this state, and who performed it.
   *
   * The core reads neither — it only stores `state`. They are declared anyway
   * because the whole message is handed to the extension's `onAppState`, and
   * writing a log line ("Bob added a shape") is the main thing an extension
   * does there. A field an extension is expected to read is part of this
   * package's contract even when the reducer itself ignores it.
   */
  action?: string;
  by?: string;
}

/**
 * A high-frequency frame from one extension (a whiteboard's live pointer, say).
 * Never stored and never logged — only the latest frame per sender is kept.
 */
export interface AppRelayMessage extends HostFields {
  type: 'app-relay';
  appId: string;
  /** The sender's display name. Frames from non-members are dropped. */
  by: string;
  payload: unknown;
}

export interface TypingMessage extends HostFields {
  type: 'typing';
  name: string;
}

/** An agent's live run status. Volatile: never stored, never replayed. */
export interface AgentStatusMessage extends HostFields {
  type: 'agent-status';
  agentId: string;
  /** Identifies one run, so a late frame from a finished run can be dropped. */
  requestId: string;
  phase: 'thinking' | 'working' | 'idle';
  tool?: string;
}

/**
 * Every message `reduceSpace` understands.
 *
 * ⚠ This union is deliberately closed, so that narrowing on `type` works and
 * the reducer's dispatch needs no casts. It is *not* a claim that these are
 * the only messages allowed on the channel: an unrecognized `type` is not an
 * error at runtime — the reducer returns the state unchanged (see its
 * `default` case) — so a host is free to put its own messages through the same
 * `receive`, as `store.ts` does by accepting anything it is handed.
 */
export type SpaceMessage =
  | SpaceStateMessage
  | MemberJoinedMessage
  | MemberLeftMessage
  | MemberUpdatedMessage
  | SpaceOwnerUpdatedMessage
  | JoinRejectedMessage
  | ScreenShareStateMessage
  | FavoriteQueuedVideoMessage
  | ChatMessage
  | ChatHistoryMessage
  | ChatAckMessage
  | ChatReactionUpdateMessage
  | SpaceRenamedMessage
  | MessagePinnedMessage
  | SpaceSettingsUpdatedMessage
  | AppStateMessage
  | AppRelayMessage
  | TypingMessage
  | AgentStatusMessage;
