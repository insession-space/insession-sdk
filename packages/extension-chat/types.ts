// The wire and state shapes of the chat state machine.
//
// Types only — no runtime code lives here, so every other module in this
// package can import from it without creating an initialization order between
// them.

/**
 * A snapshot of the message a room has pinned. The host stores the message
 * *content*, not just its id, so the pin stays displayable to members who
 * haven't loaded that far back in the transcript — and stays stable if the
 * original is later edited or deleted.
 */
export interface ChatPinnedMessage {
  id: number;
  name: string;
  text: string;
  /** Epoch ms. Omitted when the host's snapshot doesn't carry one. */
  createdAt?: number;
  /** Present only for sticker messages. */
  kind?: 'sticker';
  /** Present only for sticker messages. */
  imageUrl?: string | null;
}

/**
 * Everything this package keeps in memory. Deliberately tiny — see the note
 * on the storage model at the top of `index.ts`.
 */
export interface ChatState {
  pinnedMessage: ChatPinnedMessage | null;
}

/**
 * A normalized, validated message that has not been persisted yet. Produced
 * by the `chat` action, handed to the host inside the `persist-chat` effect,
 * and handed straight back with the `chat-persisted` action once the host has
 * an id for it.
 */
export interface ChatDraft {
  kind: 'text' | 'sticker';
  /** Always `''` for stickers — a sticker carries no body text. */
  text: string;
  /** The sticker image, or `null` for a text message. */
  imageUrl: string | null;
  /** The message being replied to, or `null` when this isn't a reply. */
  replyToId: number | null;
  /** Echoed back to the sender in `chat-ack`, or `null` if they didn't send one. */
  clientMsgId: string | null;
  /** The sender's display name. */
  by: string | null;
  /** The sender's stable user id, if signed in. */
  uid: string | null;
  /** The sender's avatar URL, resolved by the host at join time. */
  avatar: string | null;
  /**
   * Epoch ms, stamped once here and reused for both the broadcast and the
   * sender's `chat-ack`, so every member — including the sender, whose clock
   * may be off — sees the same timestamp for the same message.
   */
  createdAt: number;
}

/** The reply snapshot the host resolves for a message that replies to another. */
export interface ChatReplySnapshot {
  id: number;
  name: string;
  text: string;
}

/** Aggregated reactions for one message, keyed by emoji. */
export type ChatReactionCounts = Record<string, { count: number; names: string[] }>;

export type ChatAction =
  | 'chat'
  | 'chat-persisted'
  | 'chat-reaction'
  | 'chat-reaction-toggled'
  | 'typing'
  | 'pin-message'
  | 'pin-message-resolved';

/**
 * Payload shapes for each action. Most fields are loosely typed because
 * `reduce` sits behind a wire boundary and treats them as untrusted input —
 * every one is validated (and safely ignored or rejected) at the point of
 * use.
 *
 * A few fields are **host-trusted** rather than wire data: `by`, `uid`,
 * `avatar` and `stickerAllowed`. The host is expected to fill these in from
 * the authenticated connection (and from its own storage, for
 * `stickerAllowed`) *before* calling `reduce`, never to pass them through
 * from the client — the same expectation `extension-pomodoro` has for its
 * `by`/`uid` and `extension-watch-party` has for its settings fields.
 */
export interface ChatPayload {
  /** `chat`: the message body. Ignored for stickers. */
  text?: unknown;
  /** `chat`: `'sticker'` to attempt a sticker message; anything else is a text message. */
  kind?: unknown;
  /** `chat`: the sticker image URL. */
  imageUrl?: unknown;
  /**
   * `chat` (**host-trusted**): whether `imageUrl` passed the host's allowlist.
   *
   * Deciding which image URLs may enter a shared room is a genuine trust
   * boundary, and in every real host it needs I/O (a storage-ownership check,
   * a lookup of admin-managed sticker sets, a per-space allowlist). That can't
   * be a synchronous injected predicate the way
   * `extension-whiteboard`'s `isOwnImageUrl` is, and making it async would
   * force `reduce` to be async too. So the host resolves it first and folds
   * the answer in here.
   *
   * Anything other than `true` means "not allowed", and the message quietly
   * falls back to being a plain text message — never a rejection, so a stale
   * or revoked sticker can't silently swallow someone's message.
   */
  stickerAllowed?: unknown;
  /** `chat`: id of the message being replied to. */
  replyToId?: unknown;
  /** `chat`: the sender's own correlation id, echoed back in `chat-ack`. */
  clientMsgId?: unknown;
  /** `chat`/`typing`/`pin-message` (**host-trusted**): the acting member's display name. */
  by?: unknown;
  /** `chat` (**host-trusted**): the sender's stable user id, if signed in. */
  uid?: unknown;
  /** `chat` (**host-trusted**): the sender's avatar URL. */
  avatar?: unknown;
  /** `chat-persisted`: the draft handed out by the preceding `persist-chat` effect. */
  draft?: unknown;
  /** `chat-persisted`: the persisted message id, or `null` if the host has no storage. */
  id?: unknown;
  /**
   * `chat-persisted`: the resolved reply snapshot. `null` means "the message
   * being replied to is gone"; omit the field entirely when this wasn't a
   * reply at all. The two are distinct on the wire — see `chat-persisted`.
   */
  replyTo?: unknown;
  /** `chat-reaction`/`chat-reaction-toggled`/`pin-message`: the target message id. */
  messageId?: unknown;
  /** `chat-reaction`: the emoji being toggled. */
  emoji?: unknown;
  /** `chat-reaction-toggled`: the re-counted aggregate for the message. */
  reactions?: unknown;
  /**
   * `chat-reaction-toggled`: pass `false` when the toggle didn't apply (e.g.
   * the message belongs to another room). Nothing is broadcast in that case.
   */
  ok?: unknown;
  /** `pin-message-resolved`: the snapshot the host looked up, or `null` if there was none. */
  pinned?: unknown;
}

/**
 * Side effects `reduce` asks the host to perform. `reduce` never performs I/O
 * itself — it only describes what should happen. This mirrors
 * `@insession/space-state`'s `SpaceEffect` in both shape and intent.
 */
export type ChatEffect =
  /** Send `message` to every connected member of the room. */
  | { type: 'broadcast'; message: unknown; excludeSender?: boolean }
  /** Send `message` only to whoever triggered the action (the `chat-ack` reply). */
  | { type: 'send-to-sender'; message: unknown }
  /**
   * Store `draft` and resolve its reply target, then feed the result back via
   * a `chat-persisted` action carrying the same `draft`.
   *
   * A host without storage can still feed back `{ draft, id: null }` — chat
   * keeps working, it just has no ids, so replies and reactions are
   * unavailable.
   */
  | { type: 'persist-chat'; draft: ChatDraft }
  /**
   * Toggle `by`'s `emoji` on `messageId` and re-count that message's
   * reactions, then feed the result back via `chat-reaction-toggled`.
   *
   * The host is responsible for scoping `messageId` to the current room —
   * this package never sees room ids, so it can't check that itself. Report a
   * cross-room id back as `{ ok: false }`.
   */
  | { type: 'toggle-reaction'; messageId: number; emoji: string; by: string | null }
  /**
   * Look `messageId` up and feed the snapshot back via `pin-message-resolved`
   * (or `{ pinned: null }` if there is none). Same room-scoping
   * responsibility as `toggle-reaction`.
   */
  | { type: 'resolve-message'; messageId: number }
  /** Persist the room's pinned message (`null` clears it). */
  | { type: 'persist-pinned'; pinned: ChatPinnedMessage | null }
  /**
   * Hand a newly posted text message to whatever bots/agents/integrations the
   * host runs.
   *
   * **Never await this.** Anything listening here may take seconds (an LLM
   * round trip, an outbound webhook); blocking on it would delay delivery of
   * the human message that triggered it. Stickers deliberately don't emit
   * this effect — there's no text to interpret.
   */
  | { type: 'notify-bots'; text: string; by: string | null; uid: string | null; id: number | null };

export interface CreateChatStateOptions {
  /**
   * Source of the timestamp stamped on each message. Defaults to `Date.now`.
   *
   * Injected only so tests can pin it — it is *not* a trust boundary the way
   * `extension-whiteboard`'s `isOwnImageUrl` is. Note that the timestamp
   * is taken when the message is accepted, not after the host's insert
   * returns, so it reflects when the room received the message rather than
   * how long storage took.
   */
  now?: () => number;
}

/** What `reduce` returns when it accepts an action. */
export interface ChatReduceResult {
  state: ChatState;
  effects: ChatEffect[];
}

/** The API returned by `createChatState`. */
export interface ChatStateApi {
  defaultState: () => ChatState;
  /**
   * Applies an action to the current state, returning the next state plus any
   * effects for the host to run, or `null` if the action is invalid/a no-op
   * and should be ignored entirely (no state change, no effects).
   *
   * `action` is typed as `string` rather than `ChatAction` on purpose: this
   * sits behind a wire boundary where the action name is untrusted input, and
   * any string outside the known set falls through to `null`.
   */
  reduce: (
    state: ChatState | null | undefined,
    action: string,
    payload?: ChatPayload,
  ) => ChatReduceResult | null;
  /**
   * Normalizes state loaded from storage into a safe shape. `null` only for
   * non-object input. An unusable pinned snapshot comes back as "nothing
   * pinned" rather than failing the whole restore.
   */
  restore: (raw: unknown) => ChatState | null;
}
