---
title: '@insession/space-state'
description: リアルタイムな共有ルーム（メンバー・チャット・プレゼンス・入力中・ピン留め・プラグイン）のための、依存ゼロの状態 store。
---

:::note[英語版が正です]
このページは [英語版](/packages/space-state/) を訳したものです。英語版は npm に配布される
`README.md` から自動生成されており、内容が食い違う場合は**英語版が正**です。
:::

**リアルタイムな共有ルームのための依存ゼロの状態 store** — メンバー、チャット、プレゼンス、
入力中インジケーター、ピン留めメッセージ、そして差し込み可能なルーム内アプリ。

多くのリアルタイム状態層は、本来分かれているべき3つを1つに融合させてしまいます。受信メッセージを
畳み込む reducer、それを運ぶソケット、そして何かが起きたときに発火する副作用（音・通知・タイマー）。
融合させると、いちばん面白い部分 — 状態遷移 — を、サーバーとブラウザを立ち上げずにテストできなく
なります。

この store は3つを分けたまま保ちます:

- **受信メッセージは純粋 reducer で畳み込む。** `receive(msg)` は `reduceSpace` を通します。これは
  `(state, msg, ctx)` のただの関数で、I/O をしません。
- **送信メッセージは渡すだけで、送らない。** `chat.send()` のようなローカルアクションはメッセージを
  作り、`onSend` に登録したものへ渡します。store 自身はソケットを開きません。
- **副作用は記述子として返され、実行されない。** 「チャット音を鳴らす」「通知を出す」「この入力中
  表示を3秒後に消す」は、データとして `onEffect` ハンドラに届きます。それがアプリで何を意味するかは
  あなたが決めます。
- **ランタイム依存ゼロ。** React も WebSocket も DOM もありません。テストは `node --test` で、
  サーバーもブラウザもソケットも無しに完結します。

## インストール

```sh
npm install @insession/space-state
```

ビルド済み ESM パッケージ（`dist/index.js` + `dist/index.d.ts`）として配布され、ランタイム依存は
ゼロです。React に繋ぐなら
[`@insession/space-state-react`](https://www.npmjs.com/package/@insession/space-state-react) を足します。

## 使い方

```ts
import { createSpaceStore } from '@insession/space-state';

const store = createSpaceStore({
  selfName: 'alice',
  t: (key) => key,            // 任意の文言解決関数。i18n の t をそのまま渡せる。テストなら恒等関数でよい
  getPresence: () => 'active',
});

// 送信: ローカルアクションを transport に配線する。実際に送るのはあなたの責務。
store.onSend((msg) => ws.send(JSON.stringify(msg)));

// 副作用: store は記述するだけで、実行するのはあなた。
store.onEffect((effect) => {
  if (effect.type === 'sound' && effect.sound === 'chat') playChatSound();
  if (effect.type === 'notify-chat') notify(`${effect.name}: ${effect.text}`);
});

// 受信: サーバーからの生メッセージを流し込む。reducer が畳み込み、購読者へ通知する。
ws.onmessage = (ev) => store.receive(JSON.parse(ev.data));

// state を読む / 変更を購読する（useSyncExternalStore の契約:
// 何も変わっていない限り getState() は同一参照を返す）
store.getState().members;
const unsubscribe = store.subscribe(() => render());

// ローカルアクション: サーバーへ送り、意味のある場面では楽観的にローカルへも反映する。
store.chat.send('hello');
store.chat.react(messageId, '🎉');
store.presence.change('away');
store.settings.update({ theme: 'dark' });
```

### サーバーなしでテストする

`receive` はただのオブジェクトを取り、effect は記述子でしかないので、状態遷移まるごとを
プロセス内で assert できます:

```ts
const store = createSpaceStore({ selfName: 'alice', t: (k) => k, getPresence: () => 'active' });
const effects = [];
store.onEffect((e) => effects.push(e));

store.receive({ type: 'chat', name: 'bob', text: 'hi' });

store.getState().chatLines.at(-1).text;
// 'hi'
effects;
// [{ type: 'typing-timer-clear', name: 'bob' },
//  { type: 'sound', sound: 'chat' },
//  { type: 'notify-chat', name: 'bob', text: 'hi' }]
```

## API

### `createSpaceStore(options): SpaceStore`

| オプション | 既定値 | 意味 |
| --- | --- | --- |
| `selfName` | — | ローカルユーザーの表示名。自分のメッセージを判別するのに使う。あとから `setSelfName` で差し替え可能。 |
| `t` | — | システムのチャット行のための文言解決関数 `(key, ...args) => string`。i18n の `t` か恒等関数を渡す。あとから `setT` で差し替え可能。 |
| `getPresence` | — | `() => 'active' \| 'away'`。reducer が現在のプレゼンスを必要とするたびに読まれる。 |
| `now` | `Date.now` | 時計。テストを決定論的にしたいときに注入する。 |
| `genClientMsgId` | `crypto.randomUUID`（フォールバックあり） | ローカルにエコーしたチャット行を、サーバーが後から採番する id に結びつける一時 ID を生成する。 |
| `plugins` | `[]` | ルーム内アプリのクライアント（[プラグイン](#プラグイン)を参照）。core 自身はアプリ固有のことを何も知らない。 |
| `initialSettings` | `{}` | `state.settings` の既定値。store は `settings` の中身を一切読まないので、その形はあなたのワイヤ契約の一部として既定値ごと注入する。 |

### store のメソッド

| メンバー | 意味 |
| --- | --- |
| `receive(msg)` | 生の受信メッセージを畳み込む。state を更新し effect を配る。 |
| `getState()` / `subscribe(fn)` | `useSyncExternalStore` 互換の組。state が変わらない限り `getState()` は同一参照を返す。`subscribe` は解除関数を返す。 |
| `onSend(fn)` / `send(msg)` | transport を登録する / 生の送信メッセージを流す。解除関数を返す。 |
| `onEffect(fn)` | effect の実行者を登録する。解除関数を返す。 |
| `chat.send(text, replyTo?)` | チャットを送り、往復を待たずに即座にローカルへエコーする。 |
| `chat.sendSticker(imageUrl)` | 画像メッセージを送る。`imageUrl` は事前にアップロード済みの URL。 |
| `chat.react(messageId, emoji)` | 絵文字リアクションをトグルし、ローカルにも楽観的に反映する。`messageId` が `null`（サーバー id 未採番）のときは何もしない。 |
| `chat.pin(messageId)` | メッセージをピン留めする。`null` で解除。権威はサーバー側にある。 |
| `chat.typing()` | 入力中を通知する。**キー入力のたびに呼んでよい** — 1秒以内の連打は間引かれる。 |
| `settings.update(patch)` | 設定の差分を送る。store は中身を解釈しない。 |
| `presence.change(p)` | `'active'` / `'away'` を送る。 |
| `stage.change(stage)` | 自分がいまどのカードを表示しているかを送る（未選択は `null`）。 |
| `addChatLine(line)` | ローカルなシステム行を追加する。 |
| `clearTyping(name)` / `expireAgentStatus(id, requestId)` | 対応する `typing-timer` / `agent-timer` の effect が発火したときに、あなたが呼ぶ。 |
| `reset()` | 切断時に、接続スコープの state をリセットする。 |
| `setT(fn)` / `setSelfName(name)` | 再接続せずに文言解決関数 / 表示名を差し替える。 |

### effect

`onEffect` は `SpaceEffect` を受け取ります。`type` で判別する union です:

| `type` | ペイロード | 何をしてほしいか |
| --- | --- | --- |
| `sound` | `sound: 'join' \| 'chat'` | 音を鳴らす。 |
| `notify-join` / `notify-chat` | `name`、チャットなら `text` も | 通知を出す。文面とメンション判定はあなたの担当。 |
| `plugin-sound` / `plugin-notify` | `appId`、`sound` / `text` | 同じだが plugin 由来。`appId` を実際の音へ対応づけるのはあなた。 |
| `history-title` | `title` | ローカルの訪問履歴を更新する。 |
| `send` | `message` | このメッセージを送る（reducer 起因。プレゼンスの再申告など）。 |
| `typing-timer` / `typing-timer-clear` | `name` | `clearTyping(name)` を呼ぶ3秒タイマーを張る / 解除する。 |
| `agent-timer` / `agent-timer-clear` | `agentId`、`requestId` | `expireAgentStatus(...)` を呼ぶ保険タイマーを張る / 解除する。 |

### プラグイン

ルームはアプリをホストできます。core はアプリ固有のロジックを持たず、各アプリが `PluginClient` を
渡し、reducer は自分の `appId` のときだけそれを呼びます:

```ts
import { definePluginClient } from '@insession/space-state';

const timer = definePluginClient({
  id: 'timer',
  // 入室/再接続時に、この plugin のローカルスライス（state.pluginLocal['timer']）を初期化する。
  // ⚠ ここでは「直前値を記録するだけ」に徹すること。入室時に判定して effect を出すと、
  // 誰かが入室するたびに発火してしまう。
  initLocal: (appState) => ({ phase: appState?.phase ?? null }),
  // この id 宛の app-state 受信ごとに呼ばれる。core は最新値を state.apps[id] に格納済みなので、
  // ここでは自分のローカルスライス・積むチャット行・出す effect だけを返せばよい。
  onAppState: ({ local, msg }) =>
    local.phase === msg.phase
      ? {}
      : { local: { phase: msg.phase }, effects: [{ type: 'plugin-sound', appId: 'timer', sound: 'ding' }] },
});

createSpaceStore({ /* … */ plugins: [timer] });
```

### `settings` について

`state.settings` は意図的に不透明（`Record<string, any>`）です。store はそれを丸ごと保持・置換する
だけで中身を覗かないため、**設定の型も既定値（`initialSettings` 経由）も、このパッケージではなく
あなたのワイヤ契約の一部**でいられます。store をサーバーからも永続化からも切り離しているのと
同じ考え方です。

## テスト

```sh
node --test
```

reducer のテストは状態遷移を直接 assert します。サーバーもブラウザもソケットも実時間の待ちも
ありません。

## 由来

[InSession](https://insession.space) のリアルタイムなルームから切り出したものです。そこでは同期
再生のウォッチパーティ、共有タイマー、ルーム内チャットを支えています。汎用化にあたっては、
プロダクトのワイヤ契約の型を外し（settings を不透明にし）、副作用を reducer の外へ記述子として
追い出し、アプリ固有の振る舞いをすべて plugin の契約の裏へ移しました。

## ライセンス

MIT
