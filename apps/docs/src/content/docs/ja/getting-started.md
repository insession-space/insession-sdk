---
title: はじめかた
description: '@insession のパッケージが何で、どう噛み合い、最初にどれを取ればよいか。'
---

`@insession` SDK は、本番稼働中のリアルタイムアプリから切り出した小さなパッケージ群です。
互いに独立しているので、1つだけ採用して残りを無視できます。

| パッケージ | 何をするか | ランタイム依存 |
| --- | --- | --- |
| [`@insession/space`](/ja/packages/space/) | 親パッケージ。extension の集合からヘッドレスな space を組み立てる: 契約（`defineSpaceExtension`）・集約 registry・メンバー/presence のライフサイクル・受理したアクションを effect 記述子に変えるインスタンス（`createSpace`）。それ自身は I/O を一切しない。 | なし |
| [`@insession/ws-resilient-transport`](/ja/packages/ws-resilient-transport/) | デプロイを跨いで WebSocket を繋ぎ続ける: サービス再起動時は高速再接続、それ以外はジッター付きバックオフ、terminal な close code では再接続を止める。 | なし |
| [`@insession/space-state`](/ja/packages/space-state/) | 共有ルームの状態（メンバー・チャット・プレゼンス・入力中・plugin）を、受信メッセージに対する純粋 reducer として持つ。 | なし |
| [`@insession/extension-chat`](/ja/packages/extension-chat/) | サーバーを正とするチャットの状態機械: メッセージの正規化・スタンプの allowlist 照合・返信・リアクション・ピン留め。`reduce` は `{ state, effects }` を返す — 永続化・broadcast・bot 通知は effect 記述子。 | なし |
| [`@insession/extension-pomodoro`](/ja/packages/extension-pomodoro/) | サーバーを正とするポモドーロタイマーの状態機械: 純粋な `reduce` に、永続化の境界を扱う `restore`/`persistState` を加えたもの。 | なし |
| [`@insession/extension-whiteboard`](/ja/packages/extension-whiteboard/) | サーバーを正とするホワイトボードの状態機械: 共有の自由描画 strokes/shapes に、オプションの「お絵かき伝言ゲーム」relay を加えたもの。 | なし |
| [`@insession/extension-watch-party`](/ja/packages/extension-watch-party/) | サーバーを正とする Watch Party の状態機械: キューと履歴を伴う動画/音声の同期再生。`reduce` は `{ state, effects }` を返すだけで、それ自身は I/O をしない。 | なし |

## どう噛み合うか

パッケージ間に import の依存は1本もありません。`space` は自分が組み立てる状態機械に依存せず、
トランスポートは store に依存せず、store もトランスポートに依存しません — 全部の配線は
あなたが行います:

```
  あなたのサーバー                            あなたのクライアント
     │                                           │
     ├── @insession/space                        ├── @insession/space-state
     │      extensions: [Chat, Pomodoro, …]       │      createSpaceStore({
     │      space.dispatch(appId, action)         │        plugins: space.clientExtensions(),
     │        → SpaceEffect[]（あなたが実行）      │      })
     │              │                             │              │
     │              │                             │    store.onSend(msg) ──┐
     │              │                             │    store.receive(msg) <┘
     │              │                             │              │
     └── @insession/ws-resilient-transport ───────┴──────────────┘
                （サーバーとクライアントの間のソケットはあなたが繋ぐ）
```

`space` はソケットを開くこともストレージに触ることもありません: `space.dispatch(...)` は
アクションを該当する extension の `reduce` に通し、`SpaceEffect[]`（`broadcast`・
`send-to-sender`・`schedule-timer`、またはドメイン固有の effect）を返すので、実行するのは
あなたです。`space.clientExtensions()` は同じ extension 群の client 側の畳み込みを
`space-state` の `plugins` オプションへ渡せる形で返すので、サーバー側の extension 一覧と
クライアント側の plugin 一覧が、どちらのパッケージも相手を import することなく同じ機能を
表せます。`space` の下では、トランスポートは相変わらずルームのことを何も知りません: store は
送信メッセージを `onSend` に登録したものへ渡すだけで、受信メッセージは `receive` であなたが
流し込みます。これらのうちどの2つを繋ぐのもわずか数行で済み、その代わりどのパーツも
**サーバーもブラウザも無しでテストできる**ままでいられます。

### 「plugin」対「extension」: 同じスライスの2つの呼び名

`@insession/space-state` はクライアント側の記述子を **plugin**（`definePluginClient`）と
呼びます — このオプションは `@insession/space` より前からあり、名前がそのまま残っています。
`@insession/space` はサーバー側の記述子を **extension**（`defineSpaceExtension`）と呼びます —
登録され、dispatch される対象です。両者は同じ機能の2つの半身です: `extension-chat` の
サーバー側の半身は `defineSpaceExtension` で、その client 側の半身（`app-state` に反応する
畳み込み）は `definePluginClient` の形をしていて、`space.clientExtensions()` 経由で
`space-state` に届きます。どちらの名前を変えても破壊的変更になるので、この食い違いは
そのまま残ります — 両者が並んで出てくる場所では、「plugin」は「client 側の半身」、
「extension」は「server 側の半身」と読み替えてください。

## どれが要るか

- **個々の状態機械を手で配線するのではなく、space をまるごと組み立てたい。** 中心に
  `@insession/space` を据えます: extension を `createSpace` に渡し、そこへアクションを
  dispatch し、返ってきた `SpaceEffect[]` を実行します。`space.clientExtensions()` を
  `space-state` の `plugins` オプションへ渡せば、クライアント側は自動的に揃います。
- **デプロイのたびに切れる WebSocket を抱えている。** `ws-resilient-transport` だけで足ります。
  ルームや状態のことは何も知りません。
- **共有ルームをモデル化したくて、状態のロジックをテスト可能にしたい。** `space-state` だけを
  取り、トランスポートは今のものを使い続けられます。
- **両方を React アプリで使いたい。** `ws-resilient-transport` と `space-state` を取ります。
  React 専用パッケージはありません: `getState` / `subscribe` は既に `useSyncExternalStore` の
  形に合わせてあるので、繋ぎ込みは自分のコードに置く1行で足ります。
- **チャットが要る: メッセージ・スタンプ・返信・リアクション・ピン留め。** `extension-chat`
  だけで足ります。`reduce` は `{ state, effects }` を返す — 永続化・broadcast・bot 通知は
  パッケージ自身が行う I/O ではなく effect 記述子です。
- **メンバーで一緒に start / pause / skip できる共有タイマーが要る。** `extension-pomodoro`
  だけで足ります。状態機械のみです — トランスポートとストレージは自分で用意します。
- **共有の描画キャンバスが要る（お絵かき伝言ゲームはオプション）。** `extension-whiteboard`
  だけで足ります。`extension-pomodoro` と同じ形 — 状態機械のみです。
- **キュー付きの同期動画/音声再生が要る。** `extension-watch-party` だけで足ります。
  `extension-chat` と同様に本物の副作用（broadcast・永続化・タイトル解決）を持ちますが、
  `reduce` はそれを実行せず effect 記述子として返すので、トランスポート無しでテストできる
  純粋関数のままです。`extension-pomodoro` と `extension-whiteboard` にはこれは要りません:
  副作用は自分で駆動するタイマーだけだからです。

## インストール

```sh
npm install @insession/space
```

どのパッケージもビルド済み ESM（`dist/index.js` + `dist/index.d.ts`）で配布され、TypeScript の型を
同梱しています。Node 22.18 以上、または最近のバンドラーが必要です。

## 2つを繋ぐ

```ts
import { createSpaceStore } from '@insession/space-state';
import { createResilientWebSocket } from '@insession/ws-resilient-transport';

const store = createSpaceStore({
  selfName: 'alice',
  t: (key) => key,
  getPresence: () => 'active',
});

const transport = createResilientWebSocket({
  url: 'wss://example.com/ws',
  buildOpenMessage: async ({ resumedFromServiceRestart }) => ({
    type: 'join',
    resume: resumedFromServiceRestart,
  }),
  onMessage: (msg) => store.receive(msg), // 受信: ソケット → store
  serviceRestartCode: 1012,
});

store.onSend((msg) => transport.send(msg)); // 送信: store → ソケット
transport.connect();
```

store が要求する副作用（音・通知・タイマー）は `store.onEffect` から別途届きます。
**store は「何をしてほしいか」を記述するだけで、それが何を意味するかはアプリが決めます。**

## 次に読む

- [`space`](/ja/packages/space/) — `defineSpaceExtension`・`createSpace`・effect の全一覧
- [`ws-resilient-transport`](/ja/packages/ws-resilient-transport/) — 再接続オプションの全体と、サーバー側ですべきこと
- [`space-state`](/ja/packages/space-state/) — store の API 全体、effect の一覧、plugin の契約
- [`extension-chat`](/ja/packages/extension-chat/) — チャットのアクション一覧とスタンプの allowlist
- [`extension-pomodoro`](/ja/packages/extension-pomodoro/) — タイマーのアクション一覧と永続化ヘルパー
- [`extension-whiteboard`](/ja/packages/extension-whiteboard/) — 描画のアクション一覧と relay ゲーム
- [`extension-watch-party`](/ja/packages/extension-watch-party/) — 再生のアクション一覧と effect の形
- [React バインディング](/ja/examples/react-binding/) — 1行のフックと、`getServerSnapshot` を渡さない理由
