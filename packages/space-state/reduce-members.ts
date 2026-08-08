// Messages about who is in the space.

import { pushChatLine } from './chat-lines.ts';
import type { SpaceEffect } from './effects.ts';
import type { MemberJoinedMessage, MemberLeftMessage, MemberUpdatedMessage } from './messages.ts';
import type { ReduceCtx } from './plugin.ts';
import { isFirstConnectionOfUid } from './presence.ts';
import type { ReduceResult } from './reduce-space.ts';
import type { SpaceState } from './state.ts';

/**
 * Somebody else joined — the server excludes the joiner from delivery, so this
 * is never about this client.
 *
 * The member list is always taken as given, but the announcement is not: a
 * signed-in person arriving on a second device is the same person, and a
 * reconnect after a server restart is nobody arriving at all. Either one
 * suppresses the log line, the sound and the notification.
 */
export function onMemberJoined(
  state: SpaceState,
  msg: MemberJoinedMessage,
  ctx: ReduceCtx,
): ReduceResult {
  // Evaluated against the member list from *before* this event, so it has to
  // happen before the list is replaced below.
  const isFirstConnection = isFirstConnectionOfUid(state.members, msg.member);
  let next: SpaceState = { ...state, members: msg.members };
  const effects: SpaceEffect[] = [];
  if (isFirstConnection && !msg.resumed) {
    next = pushChatLine(next, {
      kind: 'log',
      icon: 'group',
      by: msg.member.name,
      text: ctx.t('log.joined'),
      greeting: true,
    });
    effects.push({ type: 'sound', sound: 'join' });
    effects.push({ type: 'notify-join', name: msg.member.name });
  }
  return { state: next, effects };
}

/**
 * Somebody left. No log line and no sound — leaving is not worth announcing.
 *
 * What does still have to happen is the relay sweep. Relayed frames are keyed
 * by sender name, and a leaver's last frame (a half-drawn stroke, say) would
 * otherwise sit there forever as a ghost. Sweeping by "who is still here"
 * rather than by "who just left" is what makes it safe: a person still
 * connected on another device keeps their frames, and a stale entry under a
 * name nobody holds gets cleaned up too.
 */
export function onMemberLeft(state: SpaceState, msg: MemberLeftMessage): ReduceResult {
  const presentNames = new Set(msg.members.map((m) => m.name));
  const appRelay: Record<string, Record<string, unknown>> = {};
  for (const [appId, bySender] of Object.entries(state.appRelay)) {
    const rest: Record<string, unknown> = {};
    for (const [by, payload] of Object.entries(bySender)) {
      if (presentNames.has(by)) rest[by] = payload;
    }
    appRelay[appId] = rest;
  }
  return { state: { ...state, members: msg.members, appRelay }, effects: [] };
}

/**
 * One member changed. The list itself is not resent, so the entry is patched
 * in place.
 *
 * Only a switch *to* the whiteboard is logged, and never this client's own —
 * you know what you just opened.
 */
export function onMemberUpdated(
  state: SpaceState,
  msg: MemberUpdatedMessage,
  ctx: ReduceCtx,
): ReduceResult {
  const updated = msg.member;
  const before = state.members.find((m) => m.id === updated.id);
  let next = state;
  if (
    before &&
    updated.currentStage === 'whiteboard' &&
    before.currentStage !== 'whiteboard' &&
    updated.id !== state.selfId
  ) {
    next = pushChatLine(next, {
      kind: 'log',
      icon: 'edit',
      by: updated.name,
      text: ctx.t('log.whiteboardSwitch'),
      appId: 'whiteboard',
    });
  }
  next = {
    ...next,
    members: next.members.map((m) => (m.id === updated.id ? { ...m, ...updated } : m)),
  };
  return { state: next, effects: [] };
}
