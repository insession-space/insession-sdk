// Minimal definitions of the few server-owned shapes this package has to look
// inside of.
//
// They are kept deliberately small: this store works for any host, so it
// describes only what its own reducer reads and leaves the rest of a host's
// wire contract alone. A host with a richer type of its own can pass it
// straight in — these are structural, so anything with the same fields fits.
//
// ⚠ A settings type is deliberately *not* here. `SpaceState.settings` stays
// opaque (`Record<string, unknown>`) — see `state.ts` for why a
// general-purpose store should not carry one application's settings shape.

/**
 * Room for whatever a host attaches beyond the fields this package names.
 *
 * Every message and every transcript line extends this. The reducer reads
 * only what it declares, and passes the rest through untouched — a host's own
 * envelope, its ids, its timestamps — so nothing has to be stripped before
 * calling in, and nothing is lost on the way out.
 */
export interface HostFields {
  [key: string]: unknown;
}

/**
 * Reactions on one message, keyed by emoji: how many, and who.
 *
 * Whether *you* reacted is not stored — each client derives it by looking for
 * its own name in `names`, so the server can broadcast one shared value
 * instead of a different one per recipient. See `toReactionsView`.
 */
export type ChatReactionSummary = Record<string, { count: number; names: string[] }>;

/**
 * The pinned message. At most one per space, and the server decides.
 *
 * The text is snapshotted rather than referenced by id, because a member who
 * hasn't loaded that far back in the transcript still has to be able to see
 * what is pinned.
 */
export type PinnedMessage = {
  id: number;
  name: string;
  text: string;
  /**
   * How to render it — `'sticker'` is the one value this package's consumers
   * commonly branch on. Left as `string` rather than an enum so a host can
   * introduce its own kinds without this package knowing them.
   */
  kind?: string;
  imageUrl?: string;
  createdAt?: number;
};
