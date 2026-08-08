// Turning the server's shared reaction summary into the per-viewer shape a UI
// needs.
//
// The server broadcasts one value to everyone (`{ emoji: { count, names } }`)
// rather than a different one per recipient, so "did I react?" has to be
// derived on each client. `names` is carried through rather than discarded —
// it is what lets a UI show *who* reacted.

import type { ChatReactionSummary } from './types.ts';

/** One message's reactions, as a viewer sees them. */
export type ChatReactionsView = Record<
  string,
  { count: number; reactedByMe: boolean; names: string[] }
>;

export function toReactionsView(
  raw: ChatReactionSummary | undefined,
  selfName: string,
): ChatReactionsView {
  if (!raw) return {};
  const view: ChatReactionsView = {};
  for (const [emoji, data] of Object.entries(raw)) {
    view[emoji] = {
      count: data.count,
      reactedByMe: data.names.includes(selfName),
      names: data.names,
    };
  }
  return view;
}
