// State transitions that do not come from a received message: a locally
// echoed message, an optimistic reaction, a timer firing, a reconnect.
//
// Same shape and same discipline as the reducer — `(state, ...) => SpaceState`,
// with no side effects.

import { type ChatLineInput, pushChatLine } from './chat-lines.ts';
import type { SpaceState } from './state.ts';

/** Adds a line the consumer composed itself (a local system notice). */
export function addChatLine(state: SpaceState, line: ChatLineInput): SpaceState {
  return pushChatLine(state, line);
}

/**
 * Echoes a message this client just sent. The server broadcasts to everyone
 * *except* the sender, so without this the sender would watch their own
 * message take a round trip to appear.
 *
 * Identical to `addChatLine` in what it does; separate so the call site says
 * which of the two situations it is.
 */
export function appendLocalChat(state: SpaceState, line: ChatLineInput): SpaceState {
  return pushChatLine(state, line);
}

/**
 * Toggles a reaction optimistically.
 *
 * The server's own reaction update overwrites the whole set when it arrives,
 * so any disagreement here is momentary and self-correcting. `names` is
 * updated too, not just the count, so that a "who reacted" tooltip stays
 * consistent in the meantime.
 */
export function toggleReactionLocally(
  state: SpaceState,
  messageId: number,
  emoji: string,
  selfName: string,
): SpaceState {
  const chatLines = state.chatLines.map((line) => {
    // The `kind` check is what makes `reactions` below well-typed: only a chat
    // message carries them. A log line has no storage id to match on anyway.
    if (line.kind !== 'chat' || line.id !== messageId) return line;
    const reactions = { ...(line.reactions ?? {}) };
    const cur = reactions[emoji];
    const curNames: string[] = cur?.names ?? [];
    if (cur?.reactedByMe) {
      if (cur.count <= 1) delete reactions[emoji];
      else
        reactions[emoji] = {
          count: cur.count - 1,
          reactedByMe: false,
          names: curNames.filter((n) => n !== selfName),
        };
    } else {
      reactions[emoji] = {
        count: (cur?.count ?? 0) + 1,
        reactedByMe: true,
        names: curNames.includes(selfName) ? curNames : [...curNames, selfName],
      };
    }
    return { ...line, reactions };
  });
  return { ...state, chatLines };
}

/**
 * Drops somebody's typing indicator immediately, without waiting out the
 * three seconds. Cancelling the timer itself is the consumer's job — the
 * reducer emits a `typing-timer-clear` effect for it.
 */
export function clearTyping(state: SpaceState, name: string): SpaceState {
  if (!state.typingUsers.includes(name)) return state;
  return { ...state, typingUsers: state.typingUsers.filter((n) => n !== name) };
}

/**
 * Called when the backstop timer for an agent run fires.
 *
 * ⚠ Ignores the call unless this is still that agent's current run. With run A
 *   followed by run B, a late timer from A would otherwise clear B's status.
 */
export function expireAgentStatus(
  state: SpaceState,
  agentId: string,
  requestId: string,
): SpaceState {
  if (state.agentStatuses[agentId]?.requestId !== requestId) return state;
  const agentStatuses = { ...state.agentStatuses };
  delete agentStatuses[agentId];
  return { ...state, agentStatuses };
}

/**
 * Back to "not connected yet", for a reconnect.
 *
 * ⚠ `endedAgentRuns` is discarded here too. It has the same lifetime as the
 *   connection: keeping it across a reconnect would make the store behave
 *   differently depending on whether the connection was torn down, which is
 *   exactly the kind of difference nobody would think to look for.
 */
export function resetConnection(state: SpaceState): SpaceState {
  if (!state.connected && state.endedAgentRuns.length === 0) return state;
  return { ...state, connected: false, endedAgentRuns: [] };
}
