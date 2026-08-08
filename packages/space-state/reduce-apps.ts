// Messages belonging to the extensions running inside the space.
//
// The core's whole job here is the storing: put the latest slice at
// `apps[appId]`, keep the latest relayed frame per sender. Anything an
// extension wants to *say* about its own change comes from its `PluginClient`
// descriptor, never from this file — see `plugin.ts`.

import { pushChatLine } from './chat-lines.ts';
import type { SpaceEffect } from './effects.ts';
import type { AppRelayMessage, AppStateMessage, FavoriteQueuedVideoMessage } from './messages.ts';
import type { ReduceCtx } from './plugin.ts';
import type { ReduceResult } from './reduce-space.ts';
import type { SpaceState } from './state.ts';

/**
 * An extension's authoritative state. Delivered to everyone including the
 * sender, so there is no local echo to reconcile.
 *
 * Storing it happens whether or not any extension descriptor claims this
 * `appId` — an unrecognized extension's state is still state, and a consumer
 * that renders it without registering a descriptor keeps working.
 */
export function onAppState(state: SpaceState, msg: AppStateMessage, ctx: ReduceCtx): ReduceResult {
  let next: SpaceState = { ...state, apps: { ...state.apps, [msg.appId]: msg.state } };
  const effects: SpaceEffect[] = [];
  const plugin = (ctx.plugins ?? []).find((p) => p.id === msg.appId);
  const result = plugin?.onAppState?.({ local: state.pluginLocal[msg.appId], msg, ctx });
  if (result) {
    if ('local' in result) {
      next = { ...next, pluginLocal: { ...next.pluginLocal, [msg.appId]: result.local } };
    }
    // Appended in order — `pushChatLine` adds at the end, so array order is
    // display order.
    for (const line of result.lines ?? []) {
      next = pushChatLine(next, line);
    }
    for (const effect of result.effects ?? []) {
      effects.push(effect);
    }
  }
  return { state: next, effects };
}

/**
 * A high-frequency frame from one extension. Never logged and never stored —
 * only the latest per sender is kept.
 *
 * Frames from somebody who is not in the member list are dropped. Without that
 * guard, a frame that arrives just after its sender left would reinstate the
 * ghost that `onMemberLeft` just swept away.
 */
export function onAppRelay(state: SpaceState, msg: AppRelayMessage): ReduceResult {
  if (!state.members.some((m) => m.name === msg.by)) return { state, effects: [] };
  const appRelay = {
    ...state.appRelay,
    [msg.appId]: { ...(state.appRelay[msg.appId] || {}), [msg.by]: msg.payload },
  };
  return { state: { ...state, appRelay }, effects: [] };
}

/**
 * Somebody favorited a queued item on this member's behalf. Only the member it
 * was done for is told.
 */
export function onFavoriteQueuedVideo(
  state: SpaceState,
  msg: FavoriteQueuedVideoMessage,
  ctx: ReduceCtx,
): ReduceResult {
  const self = state.members.find((m) => m.id === state.selfId);
  if (self?.uid !== msg.targetUid) return { state, effects: [] };
  const next = pushChatLine(state, {
    kind: 'log',
    icon: 'star',
    by: msg.by,
    text: ctx.t('log.favoriteQueuedVideo'),
  });
  return { state: next, effects: [] };
}
