// The reducer: one received message in, the next state and a list of effects
// out. Pure — it plays no sound, sets no timer and sends nothing itself (see
// `effects.ts`).
//
// This file is only the dispatch. Each message is handled in the module for
// the part of the space it concerns, so that adding a message means touching
// one small file rather than growing one large switch:
//
//   reduce-space.ts   — the space itself: full state, owner, rename, settings,
//                       screen share
//   reduce-members.ts — who is here
//   reduce-chat.ts    — the transcript: chat, history, acks, reactions, pin,
//                       typing
//   reduce-apps.ts    — extension state and relayed frames
//   reduce-agent.ts   — agent run status
//
// ⚠ Two decisions are deliberately *not* made here, because they depend on the
// connection's authentication lifecycle, which a reducer over messages cannot
// see: recovering from `join-rejected`, and noticing that an anonymous
// connection has been upgraded on `member-updated`. Both stay with the
// consumer.

import type { SpaceMessage, UnknownSpaceMessage } from './messages.ts';
import type { ReduceCtx } from './plugin.ts';
import { onAgentStatus } from './reduce-agent.ts';
import { onAppRelay, onAppState, onFavoriteQueuedVideo } from './reduce-apps.ts';
import {
  onChat,
  onChatAck,
  onChatHistory,
  onChatReactionUpdate,
  onMessagePinned,
  onTyping,
} from './reduce-chat.ts';
import { onMemberJoined, onMemberLeft, onMemberUpdated } from './reduce-members.ts';
import {
  onJoinRejected,
  onScreenShareState,
  onSpaceOwnerUpdated,
  onSpaceRenamed,
  onSpaceSettingsUpdated,
  onSpaceState,
  type ReduceResult,
} from './reduce-space.ts';
import type { SpaceState } from './state.ts';

export type { ReduceCtx } from './plugin.ts';
export type { ReduceResult } from './reduce-space.ts';

export function reduceSpace(
  state: SpaceState,
  message: SpaceMessage | UnknownSpaceMessage,
  ctx: ReduceCtx,
): ReduceResult {
  // The one cast in this file, and the reason the cases below need none.
  // Anything with a `type` is accepted (see `UnknownSpaceMessage`), so the
  // narrowing has to start from the closed union; a `type` outside it simply
  // reaches `default`.
  const msg = message as SpaceMessage;
  switch (msg.type) {
    case 'space-state':
      return onSpaceState(state, msg, ctx);
    case 'member-joined':
      return onMemberJoined(state, msg, ctx);
    case 'member-left':
      return onMemberLeft(state, msg);
    case 'member-updated':
      return onMemberUpdated(state, msg, ctx);
    case 'space-owner-updated':
      return onSpaceOwnerUpdated(state, msg);
    case 'join-rejected':
      return onJoinRejected(state, msg);
    case 'screen-share-state':
      return onScreenShareState(state, msg, ctx);
    case 'space-renamed':
      return onSpaceRenamed(state, msg, ctx);
    case 'space-settings-updated':
      return onSpaceSettingsUpdated(state, msg, ctx);
    case 'favorite-queued-video':
      return onFavoriteQueuedVideo(state, msg, ctx);
    case 'chat':
      return onChat(state, msg, ctx);
    case 'chat-history':
      return onChatHistory(state, msg, ctx);
    case 'chat-ack':
      return onChatAck(state, msg);
    case 'chat-reaction-update':
      return onChatReactionUpdate(state, msg, ctx);
    case 'message-pinned':
      return onMessagePinned(state, msg, ctx);
    case 'app-state':
      return onAppState(state, msg, ctx);
    case 'app-relay':
      return onAppRelay(state, msg);
    case 'typing':
      return onTyping(state, msg);
    case 'agent-status':
      return onAgentStatus(state, msg);
    default:
      // An unrecognized type is not an error: a host may put its own messages
      // through the same channel. The **same state reference** goes back, so
      // nothing re-renders.
      return { state, effects: [] };
  }
}
