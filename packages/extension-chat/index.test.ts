import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type ChatDraft,
  type ChatEffect,
  createChatState,
  defaultState,
  isValidReactionEmoji,
} from './index.ts';

// A fixed clock, so every assertion about `createdAt` is exact rather than
// approximate.
const NOW = 1_700_000_000_000;
const chat = createChatState({ now: () => NOW });

// Convenience: run `chat` and return the draft the `persist-chat` effect
// carries, which is what almost every assertion below is about.
function draftOf(payload: Record<string, unknown>): ChatDraft | null {
  const r = chat.reduce(defaultState(), 'chat', payload);
  if (!r) return null;
  const effect = r.effects[0];
  assert.equal(effect.type, 'persist-chat');
  return (effect as Extract<ChatEffect, { type: 'persist-chat' }>).draft;
}

// Convenience: run the full two-step post and return the broadcast message.
function postedMessage(
  payload: Record<string, unknown>,
  persisted: Record<string, unknown> = {},
): Record<string, unknown> {
  const draft = draftOf(payload);
  assert.ok(draft);
  const r = chat.reduce(defaultState(), 'chat-persisted', { draft, id: 1, ...persisted });
  assert.ok(r);
  const broadcast = r.effects.find((e) => e.type === 'broadcast');
  assert.ok(broadcast);
  return (broadcast as Extract<ChatEffect, { type: 'broadcast' }>).message as Record<
    string,
    unknown
  >;
}

describe('defaultState / restore', () => {
  it('starts with nothing pinned', () => {
    assert.deepEqual(defaultState(), { pinnedMessage: null });
  });

  it('restores a pinned snapshot from storage', () => {
    const restored = chat.restore({
      pinnedMessage: { id: 7, name: 'ada', text: 'hi', createdAt: 5 },
    });
    assert.deepEqual(restored, {
      pinnedMessage: { id: 7, name: 'ada', text: 'hi', createdAt: 5 },
    });
  });

  it('drops an unusable pinned snapshot instead of failing the restore', () => {
    assert.deepEqual(chat.restore({ pinnedMessage: { name: 'no id' } }), { pinnedMessage: null });
    assert.deepEqual(chat.restore({}), { pinnedMessage: null });
  });

  it('returns null for non-object input', () => {
    assert.equal(chat.restore(null), null);
    assert.equal(chat.restore('nope'), null);
    assert.equal(chat.restore([]), null);
  });

  it('restores a sticker pin, but only when the image URL survives', () => {
    assert.deepEqual(
      chat.restore({
        pinnedMessage: { id: 3, name: 'a', text: '', kind: 'sticker', imageUrl: 'https://x/s.png' },
      })?.pinnedMessage,
      { id: 3, name: 'a', text: '', kind: 'sticker', imageUrl: 'https://x/s.png' },
    );
    // `kind: 'sticker'` with no URL is not a sticker.
    const noUrl = chat.restore({
      pinnedMessage: { id: 3, name: 'a', text: 'x', kind: 'sticker' },
    })?.pinnedMessage;
    assert.deepEqual(noUrl, { id: 3, name: 'a', text: 'x' });
  });
});

describe('chat: text normalization', () => {
  it('trims-to-check but stores the untrimmed text', () => {
    assert.equal(draftOf({ text: '  indented' })?.text, '  indented');
  });

  it('ignores an empty or whitespace-only message', () => {
    assert.equal(chat.reduce(defaultState(), 'chat', { text: '' }), null);
    assert.equal(chat.reduce(defaultState(), 'chat', { text: '   \n\t ' }), null);
    assert.equal(chat.reduce(defaultState(), 'chat', {}), null);
  });

  it('caps the body at 500 characters', () => {
    const draft = draftOf({ text: 'x'.repeat(600) });
    assert.equal(draft?.text.length, 500);
  });

  it('treats a non-string body as empty rather than coercing it', () => {
    assert.equal(chat.reduce(defaultState(), 'chat', { text: { a: 1 } }), null);
    assert.equal(chat.reduce(defaultState(), 'chat', { text: 42 }), null);
  });

  it('stamps a server-authoritative timestamp', () => {
    assert.equal(draftOf({ text: 'hi' })?.createdAt, NOW);
  });

  it('carries the host-trusted sender identity, not wire values', () => {
    const draft = draftOf({ text: 'hi', by: 'ada', uid: 'u1', avatar: 'https://x/a.png' });
    assert.equal(draft?.by, 'ada');
    assert.equal(draft?.uid, 'u1');
    assert.equal(draft?.avatar, 'https://x/a.png');
  });

  it('falls back to null for a missing sender identity', () => {
    const draft = draftOf({ text: 'hi' });
    assert.equal(draft?.by, null);
    assert.equal(draft?.uid, null);
    assert.equal(draft?.avatar, null);
  });
});

describe('chat: stickers', () => {
  const sticker = { kind: 'sticker', imageUrl: 'https://cdn/s.png', stickerAllowed: true };

  it('accepts an allowed sticker with no body text', () => {
    const draft = draftOf(sticker);
    assert.equal(draft?.kind, 'sticker');
    assert.equal(draft?.text, '');
    assert.equal(draft?.imageUrl, 'https://cdn/s.png');
  });

  it('falls back to a text message when the host disallows the URL', () => {
    const draft = draftOf({ ...sticker, stickerAllowed: false, text: 'and a caption' });
    assert.equal(draft?.kind, 'text');
    assert.equal(draft?.text, 'and a caption');
    assert.equal(draft?.imageUrl, null);
  });

  it('treats anything other than `true` as disallowed', () => {
    for (const allowed of [undefined, null, 'true', 1, {}]) {
      const draft = draftOf({ ...sticker, stickerAllowed: allowed, text: 'caption' });
      assert.equal(draft?.kind, 'text', `stickerAllowed=${JSON.stringify(allowed)}`);
    }
  });

  it('drops a disallowed sticker that had no caption, like any empty message', () => {
    assert.equal(chat.reduce(defaultState(), 'chat', { ...sticker, stickerAllowed: false }), null);
  });

  it('is not a sticker without an image URL, even when allowed', () => {
    const draft = draftOf({ kind: 'sticker', stickerAllowed: true, text: 'hi' });
    assert.equal(draft?.kind, 'text');
  });
});

describe('chat: replies', () => {
  it('normalizes a numeric-string reply id', () => {
    assert.equal(draftOf({ text: 'hi', replyToId: '12' })?.replyToId, 12);
  });

  it('rejects non-positive, fractional and unparseable reply ids', () => {
    for (const bad of [0, -1, 1.5, 'abc', {}, true, null, undefined, '']) {
      assert.equal(
        draftOf({ text: 'hi', replyToId: bad })?.replyToId,
        null,
        `replyToId=${JSON.stringify(bad)}`,
      );
    }
  });

  it('omits replyTo entirely when the message is not a reply', () => {
    const message = postedMessage({ text: 'hi' });
    assert.equal('replyTo' in message, false);
  });

  it('sends replyTo: null when the parent is gone', () => {
    const message = postedMessage({ text: 'hi', replyToId: 9 }, { replyTo: null });
    assert.equal('replyTo' in message, true);
    assert.equal(message.replyTo, null);
  });

  it('sends the snapshot when the parent resolves', () => {
    const message = postedMessage(
      { text: 'hi', replyToId: 9 },
      { replyTo: { id: 9, name: 'ada', text: 'parent' } },
    );
    assert.deepEqual(message.replyTo, { id: 9, name: 'ada', text: 'parent' });
  });

  it('falls back to null for a malformed snapshot', () => {
    const message = postedMessage({ text: 'hi', replyToId: 9 }, { replyTo: { name: 'no id' } });
    assert.equal(message.replyTo, null);
  });
});

describe('chat-persisted: broadcast and ack', () => {
  it('excludes the sender from the broadcast', () => {
    const draft = draftOf({ text: 'hi', by: 'ada' });
    const r = chat.reduce(defaultState(), 'chat-persisted', { draft, id: 3 });
    const broadcast = r?.effects.find((e) => e.type === 'broadcast');
    assert.equal((broadcast as Extract<ChatEffect, { type: 'broadcast' }>).excludeSender, true);
  });

  it('puts the persisted id and the draft timestamp on the wire', () => {
    const message = postedMessage({ text: 'hi', by: 'ada' }, { id: 42 });
    assert.equal(message.id, 42);
    assert.equal(message.createdAt, NOW);
    assert.equal(message.name, 'ada');
  });

  it('keeps working with no storage (id: null)', () => {
    const message = postedMessage({ text: 'hi' }, { id: null });
    assert.equal(message.id, null);
  });

  it('acks only when the sender supplied a clientMsgId', () => {
    const withId = draftOf({ text: 'hi', clientMsgId: 'c-1' });
    const acked = chat.reduce(defaultState(), 'chat-persisted', { draft: withId, id: 5 });
    const ack = acked?.effects.find((e) => e.type === 'send-to-sender');
    assert.deepEqual((ack as Extract<ChatEffect, { type: 'send-to-sender' }>).message, {
      type: 'chat-ack',
      clientMsgId: 'c-1',
      id: 5,
      createdAt: NOW,
    });

    const without = draftOf({ text: 'hi' });
    const plain = chat.reduce(defaultState(), 'chat-persisted', { draft: without, id: 5 });
    assert.equal(
      plain?.effects.some((e) => e.type === 'send-to-sender'),
      false,
    );
  });

  it('caps clientMsgId at 64 characters', () => {
    assert.equal(draftOf({ text: 'hi', clientMsgId: 'c'.repeat(80) })?.clientMsgId?.length, 64);
  });

  it('notifies bots for text messages but never for stickers', () => {
    const text = draftOf({ text: 'hey bot', by: 'ada', uid: 'u1' });
    const textResult = chat.reduce(defaultState(), 'chat-persisted', { draft: text, id: 7 });
    const notify = textResult?.effects.find((e) => e.type === 'notify-bots');
    assert.deepEqual(notify, { type: 'notify-bots', text: 'hey bot', by: 'ada', uid: 'u1', id: 7 });

    const sticker = draftOf({
      kind: 'sticker',
      imageUrl: 'https://cdn/s.png',
      stickerAllowed: true,
    });
    const stickerResult = chat.reduce(defaultState(), 'chat-persisted', { draft: sticker, id: 8 });
    assert.equal(
      stickerResult?.effects.some((e) => e.type === 'notify-bots'),
      false,
    );
  });

  it('puts kind/imageUrl on the wire only for stickers', () => {
    const plain = postedMessage({ text: 'hi' });
    assert.equal('kind' in plain, false);
    assert.equal('imageUrl' in plain, false);

    const sticker = postedMessage({
      kind: 'sticker',
      imageUrl: 'https://cdn/s.png',
      stickerAllowed: true,
    });
    assert.equal(sticker.kind, 'sticker');
    assert.equal(sticker.imageUrl, 'https://cdn/s.png');
  });

  it('ignores a missing or malformed draft', () => {
    assert.equal(chat.reduce(defaultState(), 'chat-persisted', { id: 1 }), null);
    assert.equal(chat.reduce(defaultState(), 'chat-persisted', { draft: 'nope', id: 1 }), null);
    assert.equal(
      chat.reduce(defaultState(), 'chat-persisted', { draft: { text: '  ' }, id: 1 }),
      null,
    );
  });

  it('never mutates state', () => {
    const before = defaultState();
    const draft = draftOf({ text: 'hi' });
    const after = chat.reduce(before, 'chat-persisted', { draft, id: 1 });
    assert.deepEqual(after?.state, before);
  });
});

describe('chat-reaction', () => {
  it('asks the host to toggle a valid emoji', () => {
    const r = chat.reduce(defaultState(), 'chat-reaction', {
      messageId: 4,
      emoji: '🔥',
      by: 'ada',
    });
    assert.deepEqual(r?.effects, [
      { type: 'toggle-reaction', messageId: 4, emoji: '🔥', by: 'ada' },
    ]);
  });

  it('ignores an invalid message id', () => {
    for (const bad of [0, -3, 1.5, 'x', null, undefined]) {
      assert.equal(
        chat.reduce(defaultState(), 'chat-reaction', { messageId: bad, emoji: '🔥' }),
        null,
        `messageId=${JSON.stringify(bad)}`,
      );
    }
  });

  it('ignores anything that is not a single emoji', () => {
    for (const bad of ['hello', '', '🔥🔥', 'a', 1, null, undefined]) {
      assert.equal(
        chat.reduce(defaultState(), 'chat-reaction', { messageId: 1, emoji: bad }),
        null,
        `emoji=${JSON.stringify(bad)}`,
      );
    }
  });

  it('broadcasts the re-counted aggregate to everyone, sender included', () => {
    const reactions = { '🔥': { count: 2, names: ['ada', 'bo'] } };
    const r = chat.reduce(defaultState(), 'chat-reaction-toggled', { messageId: 4, reactions });
    const broadcast = r?.effects[0] as Extract<ChatEffect, { type: 'broadcast' }>;
    assert.equal(broadcast.excludeSender, undefined);
    assert.deepEqual(broadcast.message, {
      type: 'chat-reaction-update',
      messageId: 4,
      reactions,
    });
  });

  it('broadcasts nothing when the toggle did not apply', () => {
    assert.equal(
      chat.reduce(defaultState(), 'chat-reaction-toggled', {
        messageId: 4,
        reactions: {},
        ok: false,
      }),
      null,
    );
  });

  it('falls back to an empty aggregate when the host sends none', () => {
    const r = chat.reduce(defaultState(), 'chat-reaction-toggled', { messageId: 4 });
    const broadcast = r?.effects[0] as Extract<ChatEffect, { type: 'broadcast' }>;
    assert.deepEqual((broadcast.message as { reactions: unknown }).reactions, {});
  });
});

describe('isValidReactionEmoji', () => {
  it('accepts single emoji, including multi-code-point ones', () => {
    for (const good of ['👍', '❤️', '😂', '🔥', '👏', '😮']) {
      assert.equal(isValidReactionEmoji(good), true, good);
    }
  });

  it('rejects text, empty strings, multiples and non-strings', () => {
    for (const bad of ['', 'a', 'hi', '👍👍', 'x'.repeat(9), 1, null, undefined, {}]) {
      assert.equal(isValidReactionEmoji(bad), false, JSON.stringify(bad));
    }
  });
});

describe('typing', () => {
  it('broadcasts to everyone except the typist', () => {
    const r = chat.reduce(defaultState(), 'typing', { by: 'ada' });
    assert.deepEqual(r?.effects, [
      { type: 'broadcast', message: { type: 'typing', name: 'ada' }, excludeSender: true },
    ]);
  });

  it('leaves state untouched — nothing about typing is stored', () => {
    const before = defaultState();
    assert.deepEqual(chat.reduce(before, 'typing', { by: 'ada' })?.state, before);
  });

  it('ignores a nameless typist', () => {
    assert.equal(chat.reduce(defaultState(), 'typing', {}), null);
    assert.equal(chat.reduce(defaultState(), 'typing', { by: '' }), null);
  });
});

describe('pin-message', () => {
  const pinnedState = { pinnedMessage: { id: 1, name: 'ada', text: 'pinned' } };

  it('unpins on a null id without asking the host to look anything up', () => {
    const r = chat.reduce(pinnedState, 'pin-message', { messageId: null, by: 'bo' });
    assert.equal(r?.state.pinnedMessage, null);
    assert.deepEqual(r?.effects, [
      { type: 'broadcast', message: { type: 'message-pinned', pinned: null, by: 'bo' } },
      { type: 'persist-pinned', pinned: null },
    ]);
  });

  it('treats an absent id as an unpin too', () => {
    assert.equal(chat.reduce(pinnedState, 'pin-message', { by: 'bo' })?.state.pinnedMessage, null);
  });

  it('asks the host to resolve a real id', () => {
    const r = chat.reduce(defaultState(), 'pin-message', { messageId: 12, by: 'bo' });
    assert.deepEqual(r?.effects, [{ type: 'resolve-message', messageId: 12 }]);
    assert.equal(r?.state.pinnedMessage, null);
  });

  it('ignores a malformed id rather than unpinning', () => {
    for (const bad of [0, -1, 1.5, 'abc', {}]) {
      assert.equal(
        chat.reduce(pinnedState, 'pin-message', { messageId: bad }),
        null,
        `messageId=${JSON.stringify(bad)}`,
      );
    }
  });

  it('pins the resolved snapshot and persists it', () => {
    const pinned = { id: 12, name: 'ada', text: 'read this', createdAt: 99 };
    const r = chat.reduce(defaultState(), 'pin-message-resolved', { pinned, by: 'bo' });
    assert.deepEqual(r?.state.pinnedMessage, pinned);
    assert.deepEqual(r?.effects, [
      { type: 'broadcast', message: { type: 'message-pinned', pinned, by: 'bo' } },
      { type: 'persist-pinned', pinned },
    ]);
  });

  it('keeps the current pin when the host found nothing', () => {
    assert.equal(chat.reduce(pinnedState, 'pin-message-resolved', { pinned: null }), null);
    assert.equal(chat.reduce(pinnedState, 'pin-message-resolved', {}), null);
  });

  it('replaces an existing pin — a room pins at most one message', () => {
    const next = { id: 20, name: 'bo', text: 'this instead' };
    const r = chat.reduce(pinnedState, 'pin-message-resolved', { pinned: next });
    assert.deepEqual(r?.state.pinnedMessage, next);
  });
});

describe('unknown actions', () => {
  it('ignores anything outside the known set', () => {
    for (const action of ['', 'nope', 'CHAT', '__proto__']) {
      assert.equal(chat.reduce(defaultState(), action, { text: 'hi' }), null, action);
    }
  });

  it('accepts a null/undefined incoming state', () => {
    assert.ok(chat.reduce(null, 'typing', { by: 'ada' }));
    assert.ok(chat.reduce(undefined, 'typing', { by: 'ada' }));
  });

  it('defaults `now` to Date.now when not injected', () => {
    const before = Date.now();
    const live = createChatState();
    const r = live.reduce(defaultState(), 'chat', { text: 'hi' });
    assert.ok(r);
    const draft = (r.effects[0] as Extract<ChatEffect, { type: 'persist-chat' }>).draft;
    assert.ok(draft.createdAt >= before);
  });
});
