# @insession/extension-chat

A **dependency-free, server-authoritative chat state machine**: message
normalization, sticker validation, replies, per-message emoji reactions, a
typing indicator, and a pinned message.

Chat looks like the easy part of a shared room right up until you write it.
The sender needs their message on screen instantly, but the id that replies
and reactions hang off of only exists after it's stored. An "emoji" reaction
picker will happily hand you a paragraph. A sticker URL can point anywhere on
the internet. And the timestamp everyone sees can't come from the sender's
clock, or two people will disagree about the order of their own conversation.

This package is the part of that which is *decisions*, with none of the
plumbing:

- **`reduce` is a pure function.** `(state, action, payload) => { state,
  effects } | null`. No I/O, no storage, no transport — `null` means "ignore
  this action" (an empty message, a malformed id, a reaction that's actually
  a sentence).
- **Side effects are described, not performed.** `reduce` returns effect
  descriptors — *broadcast this*, *store that*, *look this message up* — and
  your host executes them. The same convention
  [`@insession/space-state`](https://www.npmjs.com/package/@insession/space-state)
  uses.
- **It doesn't hold your transcript.** The message log belongs in your
  database. The only thing kept in memory is the pinned message, because
  that's the only chat state a room has that isn't just "the last N rows".
- **Every input is capped and validated at the wire boundary.** Body length,
  URL length, display names, ids, correlation ids. `reduce` never throws on
  malformed input; it returns `null`.
- **Reaction emoji are validated structurally, not by list.** Exactly one
  user-perceived character containing a pictographic code point — so any
  emoji works, and "👍 nice work everyone" doesn't.
- **The only impure thing in the package is `Date.now()`**, and you can
  inject even that.

## The two-step actions

Three flows need a value only your storage can produce, so they're split
across two `reduce` calls rather than making `reduce` async:

| You dispatch | You get back the effect | Run it, then dispatch |
| --- | --- | --- |
| `chat` | `persist-chat` — store the draft, resolve its reply target | `chat-persisted` |
| `chat-reaction` | `toggle-reaction` — toggle it, re-count the message | `chat-reaction-toggled` |
| `pin-message` | `resolve-message` — look the message up | `pin-message-resolved` |

The split exists because the broadcast has to carry the persisted message id,
and that id doesn't exist until you've stored the message. Folding the round
trip into `reduce` would make it `async` and put I/O inside it — losing the
property that makes this package worth having.

## Install

```sh
npm install @insession/extension-chat
```

Published as a built package with both ESM (`dist/index.js`) and CommonJS
(`dist/index.cjs`) entry points plus `dist/index.d.ts` types, no runtime
dependencies.

## Drop it into a space

If you are assembling a space with
[`@insession/space`](https://www.npmjs.com/package/@insession/space), the whole
integration is one line — the extension carries its own name, reducer and
persistence rules, and its effects arrive tagged with their origin:

```ts
import { createSpace } from '@insession/space';
import { chatExtension } from '@insession/extension-chat';

const space = createSpace({ extensions: [chatExtension()] });

space.dispatch('chat', 'chat', { text, by: name, uid, stickerAllowed });
// -> [broadcast, { type: 'extension', extension: 'chat', effect: { type: 'persist-chat', draft } }, clear-timer]
```

Every option `createChatState` takes is accepted here too, plus `{ name }` to
occupy a different key.

Nothing is imported from `@insession/space` to build that object: it satisfies
that package's `SpaceExtension` structurally, so this package keeps its zero
dependencies and everything below still works without it.

## Usage

```ts
import { createChatState, type ChatEffect, type ChatState } from '@insession/extension-chat';

const chat = createChatState();

// One ChatState per space, e.g. a Map<spaceId, ChatState>.
let state: ChatState = chat.defaultState();

// A client message arrives over your transport. `by`/`uid`/`avatar` come from
// the authenticated connection — never from the wire.
async function onClientMessage(sender: Member, msg: Record<string, unknown>) {
  const result = chat.reduce(state, 'chat', {
    text: msg.text,
    kind: msg.kind,
    imageUrl: msg.imageUrl,
    clientMsgId: msg.clientMsgId,
    replyToId: msg.replyToId,
    // Your allowlist decides which images may enter the room (see below).
    stickerAllowed: msg.kind === 'sticker' && (await isAllowedSticker(msg.imageUrl)),
    by: sender.name,
    uid: sender.uid,
    avatar: sender.avatar,
  });
  if (!result) return; // empty message, or otherwise not worth sending
  state = result.state;
  await runEffects(sender, result.effects);
}

async function runEffects(sender: Member, effects: ChatEffect[]) {
  for (const effect of effects) {
    switch (effect.type) {
      case 'persist-chat': {
        const { draft } = effect;
        // Your storage. `id: null` is fine if you have none — chat still
        // works, it just has no replies or reactions.
        const id = await db.insertMessage(draft);
        const replyTo = draft.replyToId ? await db.findMessage(draft.replyToId) : undefined;
        // Feed the result back to get the broadcast + ack.
        const next = chat.reduce(state, 'chat-persisted', { draft, id, replyTo });
        if (next) {
          state = next.state;
          await runEffects(sender, next.effects);
        }
        break;
      }
      case 'broadcast':
        broadcastToSpace(effect.message, effect.excludeSender ? sender : undefined);
        break;
      case 'send-to-sender':
        sender.send(effect.message);
        break;
      case 'persist-pinned':
        await db.savePinned(effect.pinned);
        break;
      case 'notify-bots':
        // Deliberately not awaited — see below.
        void agents.onMessage(effect);
        break;
      // ... 'toggle-reaction' and 'resolve-message' follow the same
      // run-it-then-feed-the-result-back shape as 'persist-chat'.
    }
  }
}

// Load the pin from storage when the room wakes up.
function loadFromDb(raw: unknown) {
  state = chat.restore(raw) ?? chat.defaultState();
}
```

### Actions

`reduce(state, action, payload)` accepts these `action` strings:

| Action | Payload | Effect |
| --- | --- | --- |
| `chat` | `{ text, kind?, imageUrl?, stickerAllowed?, replyToId?, clientMsgId?, by, uid, avatar }` | Normalizes and validates a new message. Returns a `persist-chat` effect carrying the draft. `null` for an empty/whitespace-only message. |
| `chat-persisted` | `{ draft, id, replyTo? }` | Broadcasts the stored message (sender excluded), acks the sender if they sent a `clientMsgId`, and notifies bots for text messages. |
| `chat-reaction` | `{ messageId, emoji, by }` | Validates the target and the emoji. Returns a `toggle-reaction` effect. |
| `chat-reaction-toggled` | `{ messageId, reactions, ok? }` | Broadcasts the re-counted aggregate to everyone. `ok: false` means the toggle didn't apply — nothing is sent. |
| `typing` | `{ by }` | Broadcasts a typing indicator to everyone but the typist. Never stored. |
| `pin-message` | `{ messageId, by }` | `messageId: null` unpins immediately; a real id returns a `resolve-message` effect. |
| `pin-message-resolved` | `{ pinned, by }` | Pins the snapshot your lookup returned. `pinned: null` returns `null` — a failed lookup leaves the current pin alone. |

Any other `action` string returns `null`. Because the payload arrives over
the wire, every field is treated as untrusted and validated at the point of
use.

### Host-trusted payload fields

`by`, `uid`, `avatar` and `stickerAllowed` are **not wire data**. Fill them in
from the authenticated connection (and from your own storage, for
`stickerAllowed`) before calling `reduce`. Passing them through from the
client would let anyone claim any name or approve any image.

`stickerAllowed` is a resolved boolean rather than an injected predicate — the
way [`@insession/extension-whiteboard`](https://www.npmjs.com/package/@insession/extension-whiteboard)
takes `isOwnImageUrl` — because in practice deciding it needs I/O: is this URL
in my bucket, is it an admin-managed sticker set, is it enabled for this room.
A predicate that returns a promise would force `reduce` to be async. So you
resolve it first and fold the answer in.

Anything other than `true` means "not allowed", and the message quietly
becomes a plain text message. That's deliberate: a revoked sticker shouldn't
silently swallow a message that also had something to say.

## API

| Export | Signature | Meaning |
| --- | --- | --- |
| `createChatState` | `(options?: { now?: () => number }) => ChatStateApi` | Builds the API. Every option is optional. |
| `defaultState()` | `() => ChatState` | A room with nothing pinned. Also a top-level export. |
| `.reduce` | `(state, action, payload?) => { state, effects } \| null` | Applies one action. `null` means "ignore" (invalid or a no-op). |
| `.restore` | `(raw: unknown) => ChatState \| null` | Normalizes state loaded from storage. `null` only for non-object input; an unusable pinned snapshot comes back as "nothing pinned". |
| `isValidReactionEmoji` | `(emoji: unknown) => emoji is string` | Exactly one user-perceived character containing a pictographic code point. Exported because hosts usually need the same check at another boundary. |

### Types

`ChatState`, `ChatPinnedMessage`, `ChatDraft`, `ChatReplySnapshot`,
`ChatReactionCounts`, `ChatAction`, `ChatPayload`, `ChatEffect`,
`ChatReduceResult`, `CreateChatStateOptions` and `ChatStateApi` are all
exported. `reduce`'s `action` parameter is typed as `string` rather than
`ChatAction` on purpose — it sits at a wire boundary where the action name is
untrusted input, and anything outside the known set falls through to `null`.

### Why the sender is excluded from the broadcast

The sender already rendered their own message optimistically, the instant they
hit enter — waiting for a server round trip to see your own text feels broken.
So the broadcast skips them, and they get `chat-ack` instead, carrying the one
thing their local copy is missing: the persisted id. Send a `clientMsgId` with
the message and it comes back in the ack, so you know which local row to
update.

Reactions work the other way round: `chat-reaction-update` goes to
*everyone*, sender included, because the aggregate ("3 people reacted 🔥") is
something only the server can compute. There's nothing to have rendered
optimistically.

### Why `replyTo` distinguishes absent from `null`

Three outcomes, and members can see the difference:

- **not a reply** — the field is absent entirely
- **a reply, target found** — the snapshot
- **a reply, target gone** — `null`, which clients render as "replying to a
  deleted message"

Collapsing the last two would make a deleted parent look like an ordinary
message. Note that the reply carries a *snapshot* of the parent's text, not a
live reference: quoting is a record of what was said, and it shouldn't change
under you when the original is edited.

### Why `notify-bots` must never be awaited

Anything listening on that effect — an LLM round trip, an outbound webhook, a
moderation call — can take seconds. Awaiting it would delay delivery of the
human message that triggered it to everyone else in the room. Fire it and move
on; whatever it produces can arrive later as its own message.

Stickers don't emit the effect at all. There's no text to interpret.

### Why the timestamp comes from here

`createdAt` is stamped once, when the message is accepted, and the same value
goes into both the broadcast and the sender's ack. If each client used its own
clock, two people with a few seconds of drift would see their conversation in
different orders — and the sender's own copy would disagree with everyone
else's. Injecting `now` is for tests, not for a second source of truth.

## Test

```sh
node --test
```

The suite injects a fixed clock, so it's fully deterministic — no real clocks,
no wall-clock waits.

## License

MIT
