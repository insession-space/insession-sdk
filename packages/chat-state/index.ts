// Server-authoritative chat state machine for a realtime shared room:
// message normalization, sticker validation, replies, per-message emoji
// reactions, a typing indicator, and a pinned message.
//
// Storage model: unlike `plugin-pomodoro-state`/`plugin-watch-party-state`,
// almost nothing here lives in memory. The message log itself is owned by the
// host's database — this package never holds a transcript. The only genuine
// in-memory state is `pinnedMessage`, the one message a room has singled out.
// What this package actually owns is the *decisions*: what counts as a valid
// message, what gets normalized away, what goes on the wire, and which side
// effects the host must perform.
//
// Like `plugin-watch-party-state`, `reduce` returns `{ state, effects }` — a
// list of effect descriptors the host interprets and executes (write to its
// DB, broadcast over its transport, hand the text to a bot) — rather than
// taking callbacks. This mirrors the convention `@insession/space-state`'s
// `reduceSpace` already uses and keeps `reduce` pure and testable without
// mocking I/O.
//
// ## Two-step actions
//
// Three flows need a value only the host's storage can produce, so they are
// split across two `reduce` calls, exactly like `plugin-watch-party-state`'s
// `resolve-metadata` round trip:
//
// | first action     | effect the host runs                  | feed the result back as |
// | ---------------- | ------------------------------------- | ----------------------- |
// | `chat`           | `persist-chat` (insert, resolve reply) | `chat-persisted`        |
// | `chat-reaction`  | `toggle-reaction` (toggle, re-count)   | `chat-reaction-toggled` |
// | `pin-message`    | `resolve-message` (look the message up)| `pin-message-resolved`  |
//
// The split exists because the broadcast payload has to carry the persisted
// message id (reactions and replies target it), and an id only exists after
// the host's insert. Doing it in one step would force `reduce` to be `async`
// and perform I/O — losing the property that makes this package worth using.
//
// `null` return value means "ignore this action" — invalid payload, or a
// genuine no-op (e.g. pinning a message the host couldn't find, which
// deliberately leaves the current pin untouched).

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
 * on the storage model at the top of this file.
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
 * from the client — the same expectation `plugin-pomodoro-state` has for its
 * `by`/`uid` and `plugin-watch-party-state` has for its settings fields.
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
   * a lookup of admin-managed sticker sets, a per-room allowlist). That can't
   * be a synchronous injected predicate the way
   * `plugin-whiteboard-state`'s `isOwnImageUrl` is, and making it async would
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

// Caps against state bloat and adversarial oversized payloads.
const MAX_TEXT_LEN = 500;
const MAX_URL_LEN = 500;
const MAX_NAME_LEN = 100;
const MAX_UID_LEN = 64;
const MAX_CLIENT_MSG_ID_LEN = 64;
const MAX_EMOJI_LEN = 8;

// A single emoji "character" as a user perceives it. Reaction pickers let
// people choose any Unicode emoji, so a fixed list can't validate them —
// instead require exactly one grapheme cluster that contains a pictographic
// code point, which keeps ordinary text (a whole sentence, say) from being
// smuggled in as a reaction.
const EXTENDED_PICTOGRAPHIC_RE = /\p{Extended_Pictographic}/u;

/**
 * Whether `emoji` is acceptable as a per-message reaction: a single
 * user-perceived character containing a pictographic code point.
 *
 * Exported because hosts often need the same check at another boundary (an
 * HTTP endpoint, an import job) and duplicating it is how the two drift.
 */
export function isValidReactionEmoji(emoji: unknown): emoji is string {
  if (typeof emoji !== 'string' || emoji.length === 0 || emoji.length > MAX_EMOJI_LEN) return false;
  if (!EXTENDED_PICTOGRAPHIC_RE.test(emoji)) return false;
  return [...new Intl.Segmenter().segment(emoji)].length === 1;
}

// Non-strings become `''` rather than being coerced with `String(v)`. The
// server this was ported from used `String(msg.text || '')`, which turns a
// stray object into the literal text "[object Object]" — a wire boundary
// shouldn't invent content that way.
function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

// A display name / uid / URL. Non-strings and empty strings both become
// `null` (there's no meaningful "empty name").
function nullableStr(v: unknown, max: number): string | null {
  const s = str(v, max);
  return s || null;
}

// A storage id: a positive integer, accepted as either a number or the
// numeric string a JSON transport may deliver it as (large ids are commonly
// serialized as strings to survive `Number.MAX_SAFE_INTEGER`). Anything else
// — fractional, zero, negative, non-finite, non-numeric — becomes `null`.
function parseId(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A fresh, empty room: nothing pinned. */
export function defaultState(): ChatState {
  return { pinnedMessage: null };
}

// Normalizes a pinned-message snapshot coming from the host (either freshly
// looked up, or loaded from storage on restart). Returns `null` for anything
// that isn't a usable snapshot, which callers treat as "don't pin".
function sanitizePinned(raw: unknown): ChatPinnedMessage | null {
  if (!isPlainObject(raw)) return null;
  const id = parseId(raw.id);
  if (id === null) return null;
  const createdAt =
    typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : undefined;
  const imageUrl = nullableStr(raw.imageUrl, MAX_URL_LEN);
  const isSticker = raw.kind === 'sticker' && imageUrl !== null;
  return {
    id,
    name: str(raw.name, MAX_NAME_LEN),
    text: str(raw.text, MAX_TEXT_LEN),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(isSticker ? { kind: 'sticker' as const, imageUrl } : {}),
  };
}

// Normalizes a draft that has round-tripped through the host. It left this
// module well-formed, but it came back across an `unknown` boundary, so it's
// re-validated rather than trusted.
function sanitizeDraft(raw: unknown): ChatDraft | null {
  if (!isPlainObject(raw)) return null;
  const imageUrl = nullableStr(raw.imageUrl, MAX_URL_LEN);
  const kind = raw.kind === 'sticker' && imageUrl !== null ? 'sticker' : 'text';
  const text = kind === 'sticker' ? '' : str(raw.text, MAX_TEXT_LEN);
  if (kind === 'text' && !text.trim()) return null;
  const createdAt =
    typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : 0;
  return {
    kind,
    text,
    imageUrl: kind === 'sticker' ? imageUrl : null,
    replyToId: parseId(raw.replyToId),
    clientMsgId: nullableStr(raw.clientMsgId, MAX_CLIENT_MSG_ID_LEN),
    by: nullableStr(raw.by, MAX_NAME_LEN),
    uid: nullableStr(raw.uid, MAX_UID_LEN),
    avatar: nullableStr(raw.avatar, MAX_URL_LEN),
    createdAt,
  };
}

export interface CreateChatStateOptions {
  /**
   * Source of the timestamp stamped on each message. Defaults to `Date.now`.
   *
   * Injected only so tests can pin it — it is *not* a trust boundary the way
   * `plugin-whiteboard-state`'s `isOwnImageUrl` is. Note that the timestamp
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
