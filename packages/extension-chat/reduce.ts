// The action boundary: what an incoming action does, and which effects the
// host has to run as a result. `restore` lives here too, because it is part of
// the same returned API and reuses the same snapshot normalizer as the pin
// actions do.

import {
  isPlainObject,
  isValidReactionEmoji,
  MAX_CLIENT_MSG_ID_LEN,
  MAX_NAME_LEN,
  MAX_TEXT_LEN,
  MAX_UID_LEN,
  MAX_URL_LEN,
  nullableStr,
  parseId,
  sanitizeDraft,
  sanitizePinned,
  str,
} from './sanitize.ts';
import { defaultState } from './state.ts';
import type {
  ChatAction,
  ChatDraft,
  ChatEffect,
  ChatPayload,
  ChatPinnedMessage,
  ChatReactionCounts,
  ChatReduceResult,
  ChatReplySnapshot,
  ChatState,
  ChatStateApi,
  CreateChatStateOptions,
} from './types.ts';

/**
 * Builds the chat state API. Every option is optional; the defaults give you
 * a working chat state machine with no configuration.
 */
export function createChatState(options: CreateChatStateOptions = {}): ChatStateApi {
  const { now = Date.now } = options;

  // Sets the pin (or clears it) and tells the host to announce and store it.
  // Shared by the "clear" branch of `pin-message` and by
  // `pin-message-resolved`, which must behave identically apart from what
  // they pin.
  function applyPin(
    state: ChatState,
    pinned: ChatPinnedMessage | null,
    by: string | null,
  ): ChatReduceResult {
    return {
      state: { ...state, pinnedMessage: pinned },
      effects: [
        { type: 'broadcast', message: { type: 'message-pinned', pinned, by } },
        { type: 'persist-pinned', pinned },
      ],
    };
  }

  function reduce(
    state: ChatState | null | undefined,
    action: string,
    payload: ChatPayload = {},
  ): ChatReduceResult | null {
    const s = state || defaultState();
    switch (action as ChatAction) {
      case 'chat': {
        // A sticker needs both an image URL and the host's blessing. Failing
        // either isn't a rejection — it falls through to being an ordinary
        // text message, so a revoked sticker never silently eats a message
        // that also had something to say.
        const imageUrl = nullableStr(payload.imageUrl, MAX_URL_LEN);
        const isSticker =
          payload.kind === 'sticker' && payload.stickerAllowed === true && imageUrl !== null;
        // Stickers carry no body text. Storing `''` rather than `null` keeps
        // the text column non-nullable for hosts that want it that way.
        const text = isSticker ? '' : str(payload.text, MAX_TEXT_LEN);
        // An all-whitespace message is nothing at all. Note this checks the
        // *trimmed* text but stores the untrimmed one, preserving deliberate
        // leading indentation (code snippets, ASCII art).
        if (!isSticker && !text.trim()) return null;
        const draft: ChatDraft = {
          kind: isSticker ? 'sticker' : 'text',
          text,
          imageUrl: isSticker ? imageUrl : null,
          replyToId: parseId(payload.replyToId),
          clientMsgId: nullableStr(payload.clientMsgId, MAX_CLIENT_MSG_ID_LEN),
          by: nullableStr(payload.by, MAX_NAME_LEN),
          uid: nullableStr(payload.uid, MAX_UID_LEN),
          avatar: nullableStr(payload.avatar, MAX_URL_LEN),
          createdAt: now(),
        };
        return { state: s, effects: [{ type: 'persist-chat', draft }] };
      }

      case 'chat-persisted': {
        const draft = sanitizeDraft(payload.draft);
        if (!draft) return null;
        const id = parseId(payload.id);
        // Three distinct outcomes, and the difference is visible to members:
        //   - not a reply         -> omit `replyTo` entirely
        //   - reply, target found -> the snapshot
        //   - reply, target gone  -> `null`, which clients render as
        //                            "replying to a deleted message"
        // Collapsing the last two into one would make a deleted parent look
        // like an ordinary message.
        const replyTo: ChatReplySnapshot | null | undefined =
          draft.replyToId === null
            ? undefined
            : isPlainObject(payload.replyTo) && parseId(payload.replyTo.id) !== null
              ? {
                  id: parseId(payload.replyTo.id) as number,
                  name: str(payload.replyTo.name, MAX_NAME_LEN),
                  text: str(payload.replyTo.text, MAX_TEXT_LEN),
                }
              : null;
        const message = {
          type: 'chat',
          id,
          name: draft.by,
          text: draft.text,
          ...(replyTo === undefined ? {} : { replyTo }),
          createdAt: draft.createdAt,
          uid: draft.uid,
          // Carried on the message itself rather than looked up from the
          // current member list, so a message still shows the right avatar
          // after its sender has left the room.
          avatar: draft.avatar,
          ...(draft.kind === 'sticker' ? { kind: 'sticker', imageUrl: draft.imageUrl } : {}),
        };
        const effects: ChatEffect[] = [
          // The sender already rendered this optimistically, so they're
          // excluded — they get `chat-ack` below instead, which carries the
          // id their local copy is missing.
          { type: 'broadcast', message, excludeSender: true },
        ];
        if (draft.clientMsgId !== null) {
          effects.push({
            type: 'send-to-sender',
            message: {
              type: 'chat-ack',
              clientMsgId: draft.clientMsgId,
              id,
              createdAt: draft.createdAt,
            },
          });
        }
        if (draft.kind !== 'sticker') {
          effects.push({
            type: 'notify-bots',
            text: draft.text,
            by: draft.by,
            uid: draft.uid,
            id,
          });
        }
        return { state: s, effects };
      }

      case 'chat-reaction': {
        const messageId = parseId(payload.messageId);
        if (messageId === null) return null;
        if (!isValidReactionEmoji(payload.emoji)) return null;
        return {
          state: s,
          effects: [
            {
              type: 'toggle-reaction',
              messageId,
              emoji: payload.emoji,
              by: nullableStr(payload.by, MAX_NAME_LEN),
            },
          ],
        };
      }

      case 'chat-reaction-toggled': {
        if (payload.ok === false) return null;
        const messageId = parseId(payload.messageId);
        if (messageId === null) return null;
        const reactions = (
          isPlainObject(payload.reactions) ? payload.reactions : {}
        ) as ChatReactionCounts;
        return {
          state: s,
          effects: [
            {
              // Unlike a chat message, this goes to *everyone* including the
              // person who reacted: the aggregate they need (counts across
              // all members) is something only the server can compute, so
              // there's nothing for them to have rendered optimistically.
              type: 'broadcast',
              message: { type: 'chat-reaction-update', messageId, reactions },
            },
          ],
        };
      }

      case 'typing': {
        const name = nullableStr(payload.by, MAX_NAME_LEN);
        if (name === null) return null;
        // Purely ephemeral: never stored, never restored, and not part of
        // `ChatState` at all.
        return {
          state: s,
          effects: [{ type: 'broadcast', message: { type: 'typing', name }, excludeSender: true }],
        };
      }

      case 'pin-message': {
        const by = nullableStr(payload.by, MAX_NAME_LEN);
        // An explicit `null`/absent id means "unpin", and needs no lookup.
        if (payload.messageId === null || payload.messageId === undefined) {
          return applyPin(s, null, by);
        }
        const messageId = parseId(payload.messageId);
        if (messageId === null) return null;
        return { state: s, effects: [{ type: 'resolve-message', messageId }] };
      }

      case 'pin-message-resolved': {
        const pinned = sanitizePinned(payload.pinned);
        // The host couldn't find the message. Leave the existing pin alone
        // rather than clearing it — a failed lookup shouldn't be able to
        // unpin what somebody deliberately pinned.
        if (!pinned) return null;
        return applyPin(s, pinned, nullableStr(payload.by, MAX_NAME_LEN));
      }

      default:
        return null;
    }
  }

  function restore(raw: unknown): ChatState | null {
    if (!isPlainObject(raw)) return null;
    return { pinnedMessage: sanitizePinned(raw.pinnedMessage) };
  }

  return { defaultState, reduce, restore };
}
