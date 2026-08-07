---
title: '@insession/extension-chat'
description: 依存ゼロの、サーバーを正とするチャット状態機械。メッセージの正規化・スタンプ検証・返信・リアクション・ピン留めを担う。
---

:::note[英語版が正です]
このページは [英語版](/packages/extension-chat/) を訳したものです。英語版は npm に配布される
`README.md` から自動生成されており、内容が食い違う場合は**英語版が正**です。
:::

**依存ゼロの、サーバーを正とするチャット状態機械。** メッセージの正規化・スタンプ検証・返信・
メッセージ単位の絵文字リアクション・入力中インジケーター・ピン留めを担います。

チャットは、実際に書き始めるまでは共有ルームの中でいちばん簡単な部分に見えます。送信者は
自分のメッセージを即座に画面に出したい。けれど返信やリアクションがぶら下がる id は、保存した
あとにしか存在しません。「絵文字」のリアクションピッカーは、放っておけば段落まるごと渡してきます。
スタンプの URL はインターネット上のどこでも指せます。そして全員が見る時刻を送信者の時計から
取ると、2人が自分たちの会話の順序について食い違います。

このパッケージは、その中の**判断**にあたる部分を、配管を全部取り除いた形で持っています:

- **`reduce` は純関数。** `(state, action, payload) => { state, effects } | null`。I/O もストレージも
  トランスポートもありません。`null` は「このアクションを無視する」という意味です（空のメッセージ、
  壊れた id、実は文章だったリアクション）。
- **副作用は実行せず記述する。** `reduce` は effect 記述子 — *これを配信しろ*、*これを保存しろ*、
  *このメッセージを引いてこい* — を返し、実行はホストが行います。
  [`@insession/space-state`](https://www.npmjs.com/package/@insession/space-state) と同じ流儀です。
- **ログは持たない。** メッセージログはデータベースのものです。メモリに置くのはピン留めされた
  メッセージだけ — ルームが持つチャット状態のうち、「直近 N 行」ではない唯一のものだからです。
- **すべての入力を wire 境界で検証し、上限を掛ける。** 本文長・URL 長・表示名・id・相関 id。
  `reduce` は壊れた入力で例外を投げません。`null` を返します。
- **リアクションの絵文字はリストではなく構造で検証する。** 絵文字図形を含む書記素クラスタが
  ちょうど1つ — なので任意の絵文字が通り、「👍 nice work everyone」は通りません。
- **パッケージ全体で唯一「純粋でない」ものは `Date.now()`**、しかもそれすら注入できます。

## 2段になっているアクション

3つの流れは、ストレージにしか作れない値を必要とします。そのため `reduce` を async にするのでは
なく、`reduce` の呼び出しを2回に分けています:

| 呼ぶもの | 返ってくる effect | 実行してから呼ぶもの |
| --- | --- | --- |
| `chat` | `persist-chat` — draft を保存し、返信先を解決する | `chat-persisted` |
| `chat-reaction` | `toggle-reaction` — トグルして数え直す | `chat-reaction-toggled` |
| `pin-message` | `resolve-message` — メッセージを引く | `pin-message-resolved` |

分けているのは、broadcast が永続 id を運ばなければならず、その id はメッセージを保存するまで
存在しないからです。この往復を `reduce` の中に畳み込むと `reduce` が `async` になり、内部に I/O が
入ります — このパッケージを使う理由そのものが失われます。

## インストール

```sh
npm install @insession/extension-chat
```

ESM（`dist/index.js`）と CommonJS（`dist/index.cjs`）の両方のエントリポイント、および
`dist/index.d.ts` の型を含むビルド済みパッケージとして配布しています。ランタイム依存はありません。

## スペースに載せる

[`@insession/space`](/ja/packages/space/) でスペースを組み立てているなら、組み込みは1行です。
extension が自分の名前・reducer・永続化の規則をまとめて持ち、effect には発生源が付いて届きます。

```ts
import { createSpace } from '@insession/space';
import { chatExtension } from '@insession/extension-chat';

const space = createSpace({ extensions: [chatExtension()] });

space.dispatch('chat', 'chat', { text, by: name, uid, stickerAllowed });
// -> [broadcast, { type: 'extension', extension: 'chat', effect: { type: 'persist-chat', draft } }, clear-timer]
```

`createChatState` が受け取るオプションはすべてここでも渡せます。加えて `{ name }` で
別のキーを占有できます。

このオブジェクトを作るのに `@insession/space` から何も import していません。あちらの
`SpaceExtension` を**構造的に**満たしているだけなので、このパッケージは依存ゼロのままです。

## 使い方

```ts
import { createChatState, type ChatEffect, type ChatState } from '@insession/extension-chat';

const chat = createChatState();

// ルームごとに1つの ChatState（例: Map<roomId, ChatState>）。
let state: ChatState = chat.defaultState();

// クライアントのメッセージがトランスポート経由で届く。by / uid / avatar は認証済みの接続から
// 取る — wire の値を通してはいけない。
async function onClientMessage(sender: Member, msg: Record<string, unknown>) {
  const result = chat.reduce(state, 'chat', {
    text: msg.text,
    kind: msg.kind,
    imageUrl: msg.imageUrl,
    clientMsgId: msg.clientMsgId,
    replyToId: msg.replyToId,
    // どの画像をルームに入れてよいかは自分の allowlist が決める（下記参照）。
    stickerAllowed: msg.kind === 'sticker' && (await isAllowedSticker(msg.imageUrl)),
    by: sender.name,
    uid: sender.uid,
    avatar: sender.avatar,
  });
  if (!result) return; // 空メッセージなど、送るに値しないもの
  state = result.state;
  await runEffects(sender, result.effects);
}

async function runEffects(sender: Member, effects: ChatEffect[]) {
  for (const effect of effects) {
    switch (effect.type) {
      case 'persist-chat': {
        const { draft } = effect;
        // 自分のストレージ。ストレージが無ければ id: null でよい — チャットは動き続け、
        // 返信とリアクションだけが使えなくなる。
        const id = await db.insertMessage(draft);
        const replyTo = draft.replyToId ? await db.findMessage(draft.replyToId) : undefined;
        // 結果を戻すと broadcast と ack が返る。
        const next = chat.reduce(state, 'chat-persisted', { draft, id, replyTo });
        if (next) {
          state = next.state;
          await runEffects(sender, next.effects);
        }
        break;
      }
      case 'broadcast':
        broadcastToRoom(effect.message, effect.excludeSender ? sender : undefined);
        break;
      case 'send-to-sender':
        sender.send(effect.message);
        break;
      case 'persist-pinned':
        await db.savePinned(effect.pinned);
        break;
      case 'notify-bots':
        // 意図的に await しない（下記参照）。
        void agents.onMessage(effect);
        break;
      // ... 'toggle-reaction' と 'resolve-message' も 'persist-chat' と同じ
      // 「実行して結果を戻す」形です。
    }
  }
}

// ルームが起きたときにピンをストレージから読む。
function loadFromDb(raw: unknown) {
  state = chat.restore(raw) ?? chat.defaultState();
}
```

### アクション

`reduce(state, action, payload)` が受け付ける `action` 文字列:

| アクション | ペイロード | 効果 |
| --- | --- | --- |
| `chat` | `{ text, kind?, imageUrl?, stickerAllowed?, replyToId?, clientMsgId?, by, uid, avatar }` | 新しいメッセージを正規化・検証する。draft を運ぶ `persist-chat` effect を返す。空白のみのメッセージは `null`。 |
| `chat-persisted` | `{ draft, id, replyTo? }` | 保存済みメッセージを配信し（送信者は除外）、`clientMsgId` があれば送信者に ack を返し、テキストなら bot へ通知する。 |
| `chat-reaction` | `{ messageId, emoji, by }` | 対象と絵文字を検証し、`toggle-reaction` effect を返す。 |
| `chat-reaction-toggled` | `{ messageId, reactions, ok? }` | 数え直した集計を全員へ配信する。`ok: false` はトグルが適用されなかったという意味で、何も送らない。 |
| `typing` | `{ by }` | 入力中インジケーターを本人以外へ配信する。保存しない。 |
| `pin-message` | `{ messageId, by }` | `messageId: null` は即座に解除。実在の id なら `resolve-message` effect を返す。 |
| `pin-message-resolved` | `{ pinned, by }` | 引いてきたスナップショットをピン留めする。`pinned: null` なら `null` を返す — 引けなかったときに現在のピンを消してしまわないため。 |

これ以外の `action` 文字列はすべて `null` を返します。ペイロードは wire 越しに来るので、
すべてのフィールドを信用せず、使う時点で検証します。

### ホストが埋めるフィールド

`by` / `uid` / `avatar` / `stickerAllowed` は **wire のデータではありません。** 認証済みの接続
（`stickerAllowed` は自分のストレージ）から解決して、`reduce` を呼ぶ前に埋めてください。
クライアントの値をそのまま通すと、誰でも任意の名前を名乗り、任意の画像を承認できてしまいます。

`stickerAllowed` が
[`@insession/extension-whiteboard`](https://www.npmjs.com/package/@insession/extension-whiteboard)
の `isOwnImageUrl` のような注入述語ではなく解決済みの boolean なのは、実際にはこの判断に I/O が
要るからです — 自分のバケットの URL か、管理者が用意したスタンプセットか、このルームで有効か。
Promise を返す述語にすると `reduce` 自体が async になってしまいます。そこで先に解決して答えを
畳み込む形にしています。

`true` 以外はすべて「許可されていない」という意味で、メッセージは静かにただのテキストメッセージに
なります。これは意図的です — 取り消されたスタンプが、一緒に書いた本文まで黙って飲み込んでは
いけないからです。

## API

| Export | シグネチャ | 意味 |
| --- | --- | --- |
| `createChatState` | `(options?: { now?: () => number }) => ChatStateApi` | API を組み立てる。オプションはすべて任意。 |
| `defaultState()` | `() => ChatState` | 何もピン留めされていないルーム。トップレベルの export でもある。 |
| `.reduce` | `(state, action, payload?) => { state, effects } \| null` | アクションを1つ適用する。`null` は「無視する」（無効または no-op）。 |
| `.restore` | `(raw: unknown) => ChatState \| null` | ストレージから読んだ state を正規化する。`null` は非オブジェクト入力のときだけ。使えないピンのスナップショットは「ピンなし」になる。 |
| `isValidReactionEmoji` | `(emoji: unknown) => emoji is string` | 絵文字図形を含む書記素クラスタがちょうど1つか。ホストは同じ検査を別の境界でも必要とすることが多いので export してある。 |

### 型

`ChatState` / `ChatPinnedMessage` / `ChatDraft` / `ChatReplySnapshot` /
`ChatReactionCounts` / `ChatAction` / `ChatPayload` / `ChatEffect` /
`ChatReduceResult` / `CreateChatStateOptions` / `ChatStateApi` をすべて export しています。
`reduce` の `action` 引数を `ChatAction` ではなく `string` にしているのは意図的です — ここは
アクション名が信用できない入力として届く wire 境界で、既知の集合の外は `null` に落ちます。

### なぜ送信者は broadcast から除外されるのか

送信者は enter を押した瞬間に自分のメッセージを楽観的に描画済みです — 自分が書いた文字を見るのに
サーバー往復を待たされるのは壊れた体験です。そこで broadcast は送信者を飛ばし、代わりに
`chat-ack` を送ります。ack は手元のコピーに欠けている唯一のもの、つまり永続 id を運びます。
メッセージに `clientMsgId` を添えれば ack にそのまま返ってくるので、どのローカル行を更新すれば
よいか分かります。

リアクションは逆です。`chat-reaction-update` は送信者を含む**全員**に届きます。集計
（「3人が 🔥 を付けた」）はサーバーにしか計算できないので、楽観的に描画しておけるものが
何も無いからです。

### なぜ `replyTo` は「不在」と `null` を区別するのか

結果は3通りあり、その違いはメンバーから見えます:

- **返信ではない** — フィールドごと存在しない
- **返信で、対象が見つかった** — スナップショット
- **返信だが、対象が消えている** — `null`。クライアントは「削除されたメッセージへの返信」として
  描画する

後ろの2つを1つにまとめると、削除された親が普通のメッセージのように見えてしまいます。なお返信は
親の本文の**スナップショット**を運び、生の参照は持ちません: 引用は「そのとき何が言われたか」の
記録であり、元が編集されたときに足元で書き換わってはいけないからです。

### なぜ `notify-bots` を await してはいけないのか

その effect を受けるもの — LLM の往復、外向きの webhook、モデレーション呼び出し — は数秒かかり
えます。await すると、それを引き起こした人間のメッセージが、ルームの他の全員に届くのが遅れます。
投げたら先に進むこと。生成されたものは後から独立したメッセージとして届けばよいのです。

スタンプはこの effect を出しません。解釈すべきテキストが無いからです。

### なぜ時刻をここで採るのか

`createdAt` はメッセージを受理した時点で一度だけ打たれ、同じ値が broadcast と送信者の ack の
両方に載ります。各クライアントが自分の時計を使うと、数秒ずれた2人は自分たちの会話を違う順序で
見ることになり、しかも送信者の手元のコピーだけが他の全員と食い違います。`now` の注入はテストの
ためであって、2つ目の正を作るためではありません。

## テスト

```sh
node --test
```

テストは固定した時計を注入しているので完全に決定論的です — 実時計にも待ち時間にも依存しません。

## ライセンス

MIT
