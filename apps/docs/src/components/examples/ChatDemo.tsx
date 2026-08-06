// @insession/extension-chat の実動作デモ。
//
// ⚠ 挙動を再実装しないこと。ここは npm に出ているパッケージそのものを import して動かす。
// デモが独自の状態機械を持つと、パッケージを直したときにデモだけ古くなる。
//
// このパッケージの核は「reduce はほとんど state を持たず、代わりに host がやるべきことを
// effect 記述子で返す」こと。そのためデモ側が **host 役** を演じる（偽の DB に採番させ、
// broadcast を各メンバーの受信箱へ配る）。見せたいのは5点:
//  (a) 2段の往復（chat → persist-chat → host が採番 → chat-persisted → broadcast + ack）。
//      id が「保存したあとにしか存在しない」ことが、なぜ2段なのかの理由そのもの
//  (b) 送信者が broadcast から除外され、代わりに chat-ack を受け取る（受信箱を2つ並べると
//      「Alice には ack、Bob には chat」がそのまま見える）
//  (c) スタンプの allowlist に落ちたら**拒否ではなくテキストに落ちる**
//  (d) リアクションの絵文字検証（'🔥' は通り 'nice!' は null）
//  (e) ピン留めだけが唯一の state で、解決できなければ現在のピンを維持する
//
// ⚠ setState の updater の中で setTrace を呼ばないこと。updater は React に二度呼ばれうるので
// （StrictMode の二重呼び出し）、トレースが重複して積まれる。state は素直に読んで使う。

import {
  type ChatEffect,
  type ChatPayload,
  type ChatState,
  type ChatStateApi,
  createChatState,
} from '@insession/extension-chat';
import { useRef, useState } from 'react';
import { pushEntry, type TraceEntry, TraceList } from './Trace.tsx';

const MEMBERS = ['Alice', 'Bob'] as const;
type Member = (typeof MEMBERS)[number];

// host（このページ）だけが知っている偽のストレージ。パッケージから見えるのは
// 「allowlist を通ったかどうか」の boolean だけ。
const OWN_STICKER = 'https://cdn.example.com/stickers/wave.png';
const OTHER_STICKER = 'https://elsewhere.example/anything.gif';
const isAllowedSticker = (url: string) => url.startsWith('https://cdn.example.com/stickers/');

/** 受信箱に出す1行。どのメンバーが何を受け取ったかを、届いた形のまま出す。 */
type Received = { id: number; text: string };

function summarize(state: ChatState): string {
  const pinned = state.pinnedMessage;
  return `{ pinnedMessage: ${pinned ? `{ id: ${pinned.id}, name: '${pinned.name}' }` : 'null'} }`;
}

/** 1 effect を1行に要約する。トレースの「副作用」欄はこれの配列。 */
function describeEffect(e: ChatEffect): string {
  switch (e.type) {
    case 'persist-chat':
      return `persist-chat → { kind: '${e.draft.kind}', text: ${JSON.stringify(e.draft.text)}, replyToId: ${e.draft.replyToId ?? 'null'} } — host must store it and hand back an id`;
    case 'broadcast': {
      const msg = e.message as { type?: string };
      return `broadcast${e.excludeSender ? ' (excludeSender)' : ''} → { type: '${msg?.type}' }`;
    }
    case 'send-to-sender': {
      const msg = e.message as { type?: string; id?: number | null };
      return `send-to-sender → { type: '${msg?.type}', id: ${msg?.id ?? 'null'} }`;
    }
    case 'toggle-reaction':
      return `toggle-reaction → { messageId: ${e.messageId}, emoji: '${e.emoji}' } — host must toggle and re-count`;
    case 'resolve-message':
      return `resolve-message → { messageId: ${e.messageId} } — host must look it up`;
    case 'persist-pinned':
      return `persist-pinned → ${e.pinned ? `{ id: ${e.pinned.id} }` : 'null'}`;
    case 'notify-bots':
      return `notify-bots → { text: ${JSON.stringify(e.text)} } — never await this`;
    default:
      return String((e as { type: string }).type);
  }
}

/** broadcast / ack で届いたメッセージを、受信箱の1行に均す。 */
function describeIncoming(message: unknown): string {
  const m = message as Record<string, unknown>;
  switch (m.type) {
    case 'chat':
      return m.kind === 'sticker'
        ? `#${m.id ?? '?'} ${m.name}: [sticker]`
        : `#${m.id ?? '?'} ${m.name}: ${m.text}${m.replyTo === null ? '  (replying to a deleted message)' : m.replyTo ? `  (replying to #${(m.replyTo as { id: number }).id})` : ''}`;
    case 'chat-ack':
      return `ack: my message is now #${m.id ?? 'null'}`;
    case 'chat-reaction-update': {
      const reactions = m.reactions as Record<string, { count: number }>;
      const summary =
        Object.entries(reactions)
          .map(([emoji, r]) => `${emoji}${r.count}`)
          .join(' ') || '(none)';
      return `reactions on #${m.messageId}: ${summary}`;
    }
    case 'typing':
      return `${m.name} is typing…`;
    case 'message-pinned':
      return m.pinned
        ? `${m.by} pinned #${(m.pinned as { id: number }).id}`
        : `${m.by} removed the pin`;
    default:
      return JSON.stringify(m);
  }
}

export default function ChatDemo() {
  const [chat] = useState<ChatStateApi>(() => createChatState());
  const [state, setState] = useState<ChatState>(() => chat.defaultState());
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  const [asMember, setAsMember] = useState<Member>('Alice');
  const [inboxes, setInboxes] = useState<Record<Member, Received[]>>({ Alice: [], Bob: [] });
  const [replying, setReplying] = useState(false);
  const [lastId, setLastId] = useState<number | null>(null);

  // 偽のストレージ。採番と本文の保管だけを担う host 側の関心事。
  const db = useRef({
    nextId: 1,
    rows: new Map<number, { id: number; name: string; text: string }>(),
  });
  const inboxSeq = useRef(0);

  function dispatch(label: string, action: string, payload: ChatPayload) {
    // reduce を呼ぶたびに host が実行した副作用を積み、最後に一度だけ setState する。
    let next = state;
    const entries: Omit<TraceEntry, 'id'>[] = [];
    const received: Record<Member, Received[]> = { Alice: [], Bob: [] };
    let latestId = lastId;

    function deliver(message: unknown, excludeSender: boolean | undefined, sender: Member) {
      for (const m of MEMBERS) {
        if (excludeSender && m === sender) continue;
        inboxSeq.current += 1;
        received[m].push({ id: inboxSeq.current, text: describeIncoming(message) });
      }
    }

    function step(stepAction: string, stepPayload: ChatPayload, call: string) {
      const out = chat.reduce(next, stepAction, stepPayload);
      if (!out) {
        // null は「無効・no-op なので無視する」。握り潰さずそのまま見せる。
        entries.push({ call, ret: 'null — invalid or a no-op, ignore it', noop: true });
        return;
      }
      next = out.state;
      entries.push({
        call,
        ret: summarize(out.state),
        effects: out.effects.map(describeEffect),
      });
      // ここから下が host の仕事。パッケージは一切 I/O をしていない。
      for (const effect of out.effects) {
        switch (effect.type) {
          case 'persist-chat': {
            const { draft } = effect;
            const id = db.current.nextId++;
            db.current.rows.set(id, { id, name: draft.by ?? '', text: draft.text });
            latestId = id;
            const replyTo = draft.replyToId
              ? (db.current.rows.get(draft.replyToId) ?? null)
              : undefined;
            // 採番できたので2段目へ。これが「なぜ2段なのか」そのもの。
            step(
              'chat-persisted',
              { draft, id, ...(replyTo === undefined ? {} : { replyTo }) },
              `reduce(state, 'chat-persisted', { draft, id: ${id} })`,
            );
            break;
          }
          case 'toggle-reaction': {
            // 本物の host は DB でトグルして数え直す。ここは1件だけの簡略版。
            step(
              'chat-reaction-toggled',
              {
                messageId: effect.messageId,
                reactions: { [effect.emoji]: { count: 1, names: [asMember] } },
              },
              `reduce(state, 'chat-reaction-toggled', { messageId: ${effect.messageId}, reactions })`,
            );
            break;
          }
          case 'resolve-message': {
            const found = db.current.rows.get(effect.messageId) ?? null;
            step(
              'pin-message-resolved',
              { pinned: found, by: asMember },
              `reduce(state, 'pin-message-resolved', { pinned: ${found ? `{ id: ${found.id} }` : 'null'} })`,
            );
            break;
          }
          case 'broadcast':
            deliver(effect.message, effect.excludeSender, asMember);
            break;
          case 'send-to-sender':
            inboxSeq.current += 1;
            received[asMember].push({
              id: inboxSeq.current,
              text: describeIncoming(effect.message),
            });
            break;
          default:
            // persist-pinned / notify-bots は表に出るものが無い（トレースには出ている）。
            break;
        }
      }
    }

    step(action, payload, label);

    setState(next);
    setLastId(latestId);
    setTrace((t) => entries.reduce<TraceEntry[]>((acc, e) => pushEntry(acc, e), t));
    setInboxes((prev) => ({
      Alice: [...prev.Alice, ...received.Alice].slice(-12),
      Bob: [...prev.Bob, ...received.Bob].slice(-12),
    }));
  }

  const sender = { by: asMember, uid: `u-${asMember}`, avatar: null };

  function sendText(text: string, extra: ChatPayload = {}) {
    const payload: ChatPayload = {
      text,
      clientMsgId: `c-${db.current.nextId}`,
      ...(replying && lastId !== null ? { replyToId: lastId } : {}),
      ...sender,
      ...extra,
    };
    dispatch(`reduce(state, 'chat', { text: ${JSON.stringify(text)} })`, 'chat', payload);
  }

  function sendSticker(url: string, caption: string) {
    dispatch(
      `reduce(state, 'chat', { kind: 'sticker', imageUrl: '…', stickerAllowed: ${isAllowedSticker(url)} })`,
      'chat',
      {
        kind: 'sticker',
        imageUrl: url,
        // host が先に解決して畳み込む。パッケージ側は述語を知らない。
        stickerAllowed: isAllowedSticker(url),
        text: caption,
        clientMsgId: `c-${db.current.nextId}`,
        ...sender,
      },
    );
  }

  return (
    <div className="demo not-content">
      <div className="demo-bar">
        <span>@insession/extension-chat</span>
        <span className="demo-api">createChatState / reduce / restore</span>
      </div>
      <div className="demo-body">
        <div className="demo-pane">
          <p className="demo-label">acting as</p>
          <div className="demo-controls">
            {MEMBERS.map((m) => (
              <button
                key={m}
                type="button"
                className="demo-btn"
                data-primary={asMember === m ? '' : undefined}
                onClick={() => setAsMember(m)}
              >
                as {m}
              </button>
            ))}
            <button
              type="button"
              className="demo-btn"
              data-primary={replying ? '' : undefined}
              disabled={lastId === null}
              onClick={() => setReplying((r) => !r)}
            >
              {replying ? `replying to #${lastId}` : 'reply to last'}
            </button>
          </div>

          <p className="demo-label">send</p>
          <div className="demo-controls">
            <button
              type="button"
              className="demo-btn"
              data-primary=""
              onClick={() => sendText('hello there')}
            >
              text
            </button>
            <button type="button" className="demo-btn" onClick={() => sendText('   ')}>
              whitespace only
            </button>
            <button type="button" className="demo-btn" onClick={() => sendSticker(OWN_STICKER, '')}>
              sticker (own URL)
            </button>
            <button
              type="button"
              className="demo-btn"
              onClick={() => sendSticker(OTHER_STICKER, 'and a caption')}
            >
              sticker (other URL)
            </button>
          </div>

          <p className="demo-label">react / pin / typing</p>
          <div className="demo-controls">
            <button
              type="button"
              className="demo-btn"
              disabled={lastId === null}
              onClick={() =>
                dispatch(
                  `reduce(state, 'chat-reaction', { messageId: ${lastId}, emoji: '🔥' })`,
                  'chat-reaction',
                  { messageId: lastId, emoji: '🔥', by: asMember },
                )
              }
            >
              react 🔥
            </button>
            <button
              type="button"
              className="demo-btn"
              disabled={lastId === null}
              onClick={() =>
                dispatch(
                  `reduce(state, 'chat-reaction', { messageId: ${lastId}, emoji: 'nice!' })`,
                  'chat-reaction',
                  { messageId: lastId, emoji: 'nice!', by: asMember },
                )
              }
            >
              react "nice!"
            </button>
            <button
              type="button"
              className="demo-btn"
              disabled={lastId === null}
              onClick={() =>
                dispatch(`reduce(state, 'pin-message', { messageId: ${lastId} })`, 'pin-message', {
                  messageId: lastId,
                  by: asMember,
                })
              }
            >
              pin last
            </button>
            <button
              type="button"
              className="demo-btn"
              onClick={() =>
                dispatch("reduce(state, 'pin-message', { messageId: null })", 'pin-message', {
                  messageId: null,
                  by: asMember,
                })
              }
            >
              unpin
            </button>
            <button
              type="button"
              className="demo-btn"
              onClick={() =>
                dispatch("reduce(state, 'typing', { by })", 'typing', { by: asMember })
              }
            >
              typing
            </button>
          </div>

          <p className="demo-label">state</p>
          <div className="demo-chips">
            <span className="demo-chip" data-on={state.pinnedMessage ? '' : undefined}>
              {state.pinnedMessage
                ? `pinned: #${state.pinnedMessage.id} ${state.pinnedMessage.name}`
                : 'nothing pinned'}
            </span>
            <span className="demo-chip">stored: {db.current.rows.size}</span>
          </div>

          <p className="demo-label">what each member received</p>
          {MEMBERS.map((m) => (
            <div key={m}>
              <p className="demo-label">{m}</p>
              <p className="demo-readout">
                {inboxes[m].length === 0
                  ? '(nothing yet)'
                  : inboxes[m].map((line) => line.text).join('\n')}
              </p>
            </div>
          ))}
        </div>

        <div className="demo-pane">
          <p className="demo-label">calls</p>
          <TraceList entries={trace} empty="Send something — every reduce call shows up here." />
        </div>
      </div>
    </div>
  );
}
