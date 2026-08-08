// The chat transcript: what a line is, and the one way lines get added.
//
// Both entry points go through `pushChatLine` — the reducer (a received chat
// message, or a system log line) and the local actions (`actions.ts`, for the
// echo of a message this client just sent). Keeping the key counter and the
// trim in one place is what stops the two paths from drifting.

import { CHAT_LINES_MAX, type SpaceState } from './state.ts';
import type { HostFields } from './types.ts';

/**
 * A system line: somebody joined, the space was renamed, a screen share
 * started. Rendered differently from a chat message and never persisted.
 */
export interface ChatLogLine extends HostFields {
  kind: 'log';
  /** Already-resolved text. The reducer resolves it through `ctx.t`. */
  text: string;
  /** Icon name for the host to render. Opaque to this package. */
  icon?: string;
  /** Who the line is about. */
  by?: string;
  /** Marks a line the host may want to greet on (a first join). */
  greeting?: boolean;
  /** Which extension produced the line, when one did. */
  appId?: string;
  screenShare?: boolean;
}

/** A chat message, whether received, replayed from history, or echoed locally. */
export interface ChatMessageLine extends HostFields {
  kind: 'chat';
  name: string;
  /** Whether this client sent it. Drives "my message" rendering. */
  self?: boolean;
  text: string;
  /** Storage id, or `null` until the server's ack arrives. */
  id?: number | null;
  uid?: string | null;
  avatar?: string | null;
  /** Correlates a local echo with the ack that carries its id. */
  clientMsgId?: string;
  reactions?: Record<string, { count: number; reactedByMe: boolean; names: string[] }>;
  replyTo?: { id: number; name: string; text: string };
  /** Sticker messages only. */
  imageUrl?: string;
  /** Set by the server; a client cannot claim it. */
  isAgent?: boolean;
  agentId?: string | null;
  choices?: unknown;
  /** Marks a line replayed from history rather than received live. */
  history?: boolean;
  createdAt?: number;
}

/** A line as callers hand it in, before this module stamps a key on it. */
export type ChatLineInput = ChatLogLine | ChatMessageLine;

/** A line as it lives in state. `key` is stable and unique within a session. */
export type ChatLine = ChatLineInput & { key: number };

/**
 * Appends a line, stamping it with the next key and trimming the transcript
 * back to `CHAT_LINES_MAX`.
 *
 * The key exists because rendering a list needs a stable identity per line,
 * and a chat line has none of its own: a message has no id until the server
 * acks it, and a log line never gets one.
 */
export function pushChatLine(state: SpaceState, line: ChatLineInput): SpaceState {
  const nextChatKey = state.nextChatKey + 1;
  const chatLines = [
    ...state.chatLines.slice(-(CHAT_LINES_MAX - 1)),
    { ...line, key: nextChatKey } as ChatLine,
  ];
  return { ...state, chatLines, nextChatKey };
}
