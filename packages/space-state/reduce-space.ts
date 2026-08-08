// Messages about the space itself: its full state, who owns it, what it is
// called, how it is configured, and whether somebody is sharing their screen.

import { pushChatLine } from './chat-lines.ts';
import type { SpaceEffect } from './effects.ts';
import type {
  JoinRejectedMessage,
  ScreenShareStateMessage,
  SpaceOwnerUpdatedMessage,
  SpaceRenamedMessage,
  SpaceSettingsUpdatedMessage,
  SpaceStateMessage,
} from './messages.ts';
import type { ReduceCtx } from './plugin.ts';
import type { SpaceState } from './state.ts';

/** What every handler in this package returns. */
export interface ReduceResult {
  state: SpaceState;
  effects: SpaceEffect[];
}

/**
 * The whole space, on join and on every reconnect. This is also the point at
 * which the connection counts as established.
 */
export function onSpaceState(
  state: SpaceState,
  msg: SpaceStateMessage,
  ctx: ReduceCtx,
): ReduceResult {
  const effects: SpaceEffect[] = [];
  const next: SpaceState = {
    ...state,
    connected: true,
    selfId: typeof msg.selfId === 'number' ? msg.selfId : null,
    members: msg.members,
    title: msg.title || null,
    pinnedMessage: msg.pinnedMessage || null,
    owner: msg.owner || null,
    kind: msg.kind === 'my_space' ? 'my_space' : 'ephemeral',
    community: msg.community || null,
    settings: msg.settings || ctx.defaultSettings,
    communityId: msg.communityId || null,
    features: msg.features || { durationLimit: false },
    apps: msg.apps || {},
    screenShareSharer: msg.screenShareSharer || null,
    // Each extension's initial private slice. `initLocal` is contractually
    // "record the value and nothing else" (see `plugin.ts`), so no effect can
    // come out of here.
    pluginLocal: (ctx.plugins ?? []).reduce<Record<string, unknown>>((acc, p) => {
      if (p.initLocal) acc[p.id] = p.initLocal(msg.apps?.[p.id]);
      return acc;
    }, {}),
  };
  effects.push({ type: 'history-title', title: msg.title });
  // A new connection always starts out active on the server. If this client is
  // already away — opened in a hidden tab, or reconnected while working in
  // another window — it has to say so again, or it stays listed as active
  // while nobody is there. Doing it here also covers the reconnect case, since
  // the full state arrives every time.
  if (ctx.presence !== 'active') {
    effects.push({ type: 'send', message: { type: 'presence-change', presence: ctx.presence } });
  }
  return { state: next, effects };
}

/**
 * The owner was decided while everyone stayed in the room — an anonymous
 * creator signing in, typically. Ownership otherwise only arrives with the
 * full state, so without this an owner-only control would not appear until the
 * next join.
 */
export function onSpaceOwnerUpdated(
  state: SpaceState,
  msg: SpaceOwnerUpdatedMessage,
): ReduceResult {
  return { state: { ...state, owner: msg.owner || null }, effects: [] };
}

/**
 * The join was refused.
 *
 * Deliberately inert. Recovering from this depends on the connection's own
 * authentication lifecycle — whether to retry signed in, whether to give up —
 * which this reducer has no view of. The consumer decides and acts.
 */
export function onJoinRejected(state: SpaceState, _msg: JoinRejectedMessage): ReduceResult {
  return { state, effects: [] };
}

/**
 * Somebody started or stopped sharing their screen.
 *
 * Only "nobody → somebody" is logged; stopping, and viewers coming and going,
 * are not.
 */
export function onScreenShareState(
  state: SpaceState,
  msg: ScreenShareStateMessage,
  ctx: ReduceCtx,
): ReduceResult {
  const prevSharer = state.screenShareSharer;
  const nextSharer = msg.sharer || null;
  const startsLog = !prevSharer && msg.sharer && msg.sharer.id !== state.selfId;
  // ⚠ When nothing actually changed and no line is written, return the **same
  //   state reference**. This value used to live outside the state tree, where
  //   assigning to it caused no re-render. Now that it is in the tree, the
  //   no-op transitions (a viewer joining, a repeated stop) have to be
  //   collapsed here instead.
  //   The comparison includes the name, not just the id: display names change,
  //   and folding on id alone would leave a stale name on the sharer's badge.
  const sameSharer =
    (prevSharer?.id ?? null) === (nextSharer?.id ?? null) &&
    (prevSharer?.name ?? null) === (nextSharer?.name ?? null);
  if (!startsLog && sameSharer) return { state, effects: [] };
  let next: SpaceState = { ...state, screenShareSharer: nextSharer };
  if (startsLog) {
    next = pushChatLine(next, {
      kind: 'log',
      icon: 'screen_share',
      by: msg.sharer.name,
      text: ctx.t('log.screenShareStart'),
      screenShare: true,
    });
  }
  return { state: next, effects: [] };
}

export function onSpaceRenamed(
  state: SpaceState,
  msg: SpaceRenamedMessage,
  ctx: ReduceCtx,
): ReduceResult {
  const logText = msg.title ? ctx.t('log.renamed', msg.title) : ctx.t('log.renameReset');
  let next: SpaceState = { ...state, title: msg.title || null };
  next = pushChatLine(next, { kind: 'log', icon: 'edit', by: msg.by, text: logText });
  return { state: next, effects: [{ type: 'history-title', title: msg.title }] };
}

export function onSpaceSettingsUpdated(
  state: SpaceState,
  msg: SpaceSettingsUpdatedMessage,
  ctx: ReduceCtx,
): ReduceResult {
  let next: SpaceState = { ...state, settings: msg.settings || ctx.defaultSettings };
  next = pushChatLine(next, {
    kind: 'log',
    icon: 'settings',
    by: msg.by,
    text: ctx.t('log.settingsUpdated'),
  });
  return { state: next, effects: [] };
}
