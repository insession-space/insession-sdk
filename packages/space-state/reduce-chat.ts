// Messages that make up the transcript: chat itself, its replay, the receipt
// for a message this client sent, reactions, the pinned message, and the
// typing indicator.

import { clearTyping } from './actions.ts';
import { pushChatLine } from './chat-lines.ts';
import type { SpaceEffect } from './effects.ts';
import type {
  ChatAckMessage,
  ChatHistoryMessage,
  ChatMessage,
  ChatReactionUpdateMessage,
  MessagePinnedMessage,
  TypingMessage,
} from './messages.ts';
import type { ReduceCtx } from './plugin.ts';
import { toReactionsView } from './reactions.ts';
import type { ReduceResult } from './reduce-space.ts';
import type { SpaceState } from './state.ts';

/**
 * A chat message from somebody else. This client's own messages are echoed
 * locally at send time (see `actions.ts`) and never come back through here.
 */
export function onChat(state: SpaceState, msg: ChatMessage, ctx: ReduceCtx): ReduceResult {
  let next = pushChatLine(state, {
    kind: 'chat',
    name: msg.name,
    self: false,
    text: msg.text,
    id: msg.id ?? null,
    uid: msg.uid ?? null,
    // Taken from the message rather than looked up in the member list, so it
    // still resolves for someone who has since left, and for replayed history.
    avatar: msg.avatar ?? null,
    reactions: {},
    replyTo: msg.replyTo,
    imageUrl: msg.kind === 'sticker' ? msg.imageUrl : undefined,
    // A badge marker only. The server decides this, so a client cannot claim it.
    isAgent: msg.kind === 'agent',
    // Which agent spoke, used to resolve its avatar. Like `choices`, it is not
    // stored, so replayed history has to fall back to the display name.
    agentId: msg.agentId ?? null,
    // Options an agent offers alongside its message. Deliberately absent from
    // the history branch below — they are not stored, so old proposals should
    // not come back to life.
    choices: msg.choices,
    createdAt: msg.createdAt ?? ctx.now,
  });
  // They have clearly stopped typing, so drop the indicator now instead of
  // waiting out the three seconds. The indicator (state) and the timer that
  // would have cleared it (effect) have to go together — cancelling only one
  // leaves a stray timer in the consumer.
  next = clearTyping(next, msg.name);
  const effects: SpaceEffect[] = [
    { type: 'typing-timer-clear', name: msg.name },
    { type: 'sound', sound: 'chat' },
    // Whether this mentions the reader is the consumer's call, so the raw
    // name and text are handed over unformatted.
    { type: 'notify-chat', name: msg.name, text: msg.text },
  ];
  return { state: next, effects };
}

/** Replayed transcript. No sounds, no notifications — none of it is new. */
export function onChatHistory(
  state: SpaceState,
  msg: ChatHistoryMessage,
  ctx: ReduceCtx,
): ReduceResult {
  let next = state;
  for (const m of msg.messages) {
    next = pushChatLine(next, {
      kind: 'chat',
      name: m.name,
      // An agent's message is never "yours", even if the display names collide.
      self: m.kind !== 'agent' && m.name === ctx.selfName,
      text: m.text,
      history: true,
      id: m.id ?? null,
      uid: m.uid ?? null,
      // Same reasoning as in `onChat`: the sender of an old message is usually
      // not in the room any more, so a lookup would not resolve.
      avatar: m.avatar ?? null,
      reactions: toReactionsView(m.reactions, ctx.selfName),
      replyTo: m.replyTo,
      imageUrl: m.kind === 'sticker' ? m.imageUrl : undefined,
      isAgent: m.kind === 'agent',
      createdAt: m.createdAt,
    });
  }
  return { state: next, effects: [] };
}

/**
 * The receipt for a message this client sent optimistically: it carries the
 * storage id that the local echo is missing (reactions and replies need it),
 * and the authoritative send time, so a client whose clock is off still shows
 * the same timestamp as everyone else. A server that sends no `createdAt`
 * leaves the local one alone.
 */
export function onChatAck(state: SpaceState, msg: ChatAckMessage): ReduceResult {
  const chatLines = state.chatLines.map((line) =>
    line.clientMsgId === msg.clientMsgId
      ? { ...line, id: msg.id ?? null, ...(msg.createdAt ? { createdAt: msg.createdAt } : {}) }
      : line,
  );
  return { state: { ...state, chatLines }, effects: [] };
}

export function onChatReactionUpdate(
  state: SpaceState,
  msg: ChatReactionUpdateMessage,
  ctx: ReduceCtx,
): ReduceResult {
  const chatLines = state.chatLines.map((line) =>
    line.id === msg.messageId
      ? { ...line, reactions: toReactionsView(msg.reactions, ctx.selfName) }
      : line,
  );
  return { state: { ...state, chatLines }, effects: [] };
}

export function onMessagePinned(
  state: SpaceState,
  msg: MessagePinnedMessage,
  ctx: ReduceCtx,
): ReduceResult {
  let next: SpaceState = { ...state, pinnedMessage: msg.pinned || null };
  next = pushChatLine(next, {
    kind: 'log',
    icon: 'push_pin',
    by: msg.by,
    text: msg.pinned ? ctx.t('log.messagePinned') : ctx.t('log.messageUnpinned'),
  });
  return { state: next, effects: [] };
}

/**
 * Somebody is typing.
 *
 * ⚠ If they are already shown as typing, return the **same state reference**.
 * These arrive about once a second for as long as someone keeps typing, so
 * building a new state tree each time would re-render the whole space on every
 * beat. The timer, on the other hand, has to be re-armed every time, so its
 * effect is emitted before the early return.
 */
export function onTyping(state: SpaceState, msg: TypingMessage): ReduceResult {
  const effects: SpaceEffect[] = [{ type: 'typing-timer', name: msg.name }];
  if (state.typingUsers.includes(msg.name)) return { state, effects };
  return { state: { ...state, typingUsers: [...state.typingUsers, msg.name] }, effects };
}
