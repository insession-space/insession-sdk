---
title: はじめかた
description: '@insession のパッケージが何で、どう噛み合い、最初にどれを取ればよいか。'
---

`@insession` SDK は、本番稼働中のリアルタイムアプリから切り出した小さなパッケージ群です。
パッケージ間に import の依存は1本もないので、1つだけ採用して残りを無視できます。

## 最短路

どの extension も、そのまま渡せる記述子を持っています。`createSpace` に渡せば、reducer の
配線を自分で書かずにサーバー側の機能が1つ動きます:

```ts
import { createSpace } from '@insession/space';
import { chatExtension } from '@insession/extension-chat';
import { pomodoroExtension } from '@insession/extension-pomodoro';

const space = createSpace({ extensions: [chatExtension(), pomodoroExtension()] });

const effects = space.dispatch('pomodoro', 'start');
// -> [{ type: 'broadcast', ... }, { type: 'schedule-timer', ... }]
```

`space` は I/O を一切しません。`dispatch` はアクションを該当する extension の `reduce` に
通し、`SpaceEffect[]`（`broadcast`・`send-to-sender`・`schedule-timer`、またはドメイン固有の
effect）を返すので、自分のソケット・ストレージ・タイマーに対して実行するのはあなたです。

クライアント側では、`space.clientExtensions()` が同じ extension 群の client 側の畳み込みを
`space-state` の `plugins` オプションへ渡せる形で返します。おかげでサーバー側の extension
一覧とクライアント側の plugin 一覧が、どちらのパッケージも相手を import することなく同じ
機能を表せます。

> `space-state` はクライアント側の記述子を **plugin**（`definePluginClient`）、`space` は
> サーバー側を **extension**（`defineSpaceExtension`）と呼びます。「plugin」は client 側の
> 半身、「extension」は server 側の半身と読み替えてください。両者は同じ機能の2つの半身です。

## パッケージ

| パッケージ | 何をするか | こういうときに取る |
| --- | --- | --- |
| [`@insession/space`](/ja/packages/space/) | 親パッケージ。extension の集合からヘッドレスな space を組み立てる: 契約（`defineSpaceExtension`）・集約 registry・メンバー/presence のライフサイクル・受理したアクションを effect 記述子に変えるインスタンス（`createSpace`）。 | 個々の状態機械を手で配線するのではなく、space をまるごと組み立てたいとき。 |
| [`@insession/ws-resilient-transport`](/ja/packages/ws-resilient-transport/) | デプロイを跨いで WebSocket を繋ぎ続ける: サービス再起動時は高速再接続、それ以外はジッター付きバックオフ、terminal な close code では再接続を止める。 | デプロイのたびに切れる WebSocket を抱えているとき。ルームや状態のことは何も知りません。 |
| [`@insession/space-state`](/ja/packages/space-state/) | 共有ルームの状態（メンバー・チャット・プレゼンス・入力中・plugin）を、受信メッセージに対する純粋 reducer として持つ。 | クライアント側で共有ルームをモデル化し、状態のロジックをテスト可能にしたいとき。トランスポートは今のものを使い続けられます。 |
| [`@insession/extension-chat`](/ja/packages/extension-chat/) | メッセージの正規化・スタンプの allowlist 照合・返信・リアクション・ピン留め。 | チャットが要るとき。永続化・broadcast・bot 通知は、パッケージ自身が行う I/O ではなく effect 記述子として返ります。 |
| [`@insession/extension-pomodoro`](/ja/packages/extension-pomodoro/) | 宣言と声援を伴う共有タイマー。永続化の境界を扱う `restore`/`persistState` 付き。 | メンバーで一緒に start / pause / skip できるタイマーが要るとき。トランスポートとストレージは自分で用意します。 |
| [`@insession/extension-whiteboard`](/ja/packages/extension-whiteboard/) | 共有の自由描画 strokes/shapes と、オプションの「お絵かき伝言ゲーム」relay。 | 共有の描画キャンバスが要るとき。`extension-pomodoro` と同じ形です。 |
| [`@insession/extension-watch-party`](/ja/packages/extension-watch-party/) | キューと履歴を伴う動画/音声の同期再生。 | 同期再生が要るとき。チャットと同様に本物の副作用（broadcast・永続化・タイトル解決）を持ちますが、記述子として返すので `reduce` は純粋なままです。 |

7つとも**ランタイム依存はゼロ**です。`extension-*` の4つはサーバーを正とする状態機械で、
`reduce` は `{ state, effects } | null` を返します。

## インストール

```sh
npm install @insession/space
```

どのパッケージもビルド済みで、TypeScript の型を同梱しています。`space` と `extension-*` の
4つは ESM（`dist/index.js`）と CommonJS（`dist/index.cjs`）の両方で配布されるので、
`require()` するサーバーからも読めます。`space-state` と `ws-resilient-transport` は
ESM のみです。Node 22.18 以上、または最近のバンドラーが必要です。

## 自分のトランスポートを繋ぐ

`space` はソケットを開きません。その下でも、トランスポートは相変わらずルームのことを
何も知りません: store は送信メッセージを `onSend` に登録したものへ渡すだけで、受信メッセージは
`receive` であなたが流し込みます。

```
  あなたのサーバー                            あなたのクライアント
     │                                           │
     ├── @insession/space                        ├── @insession/space-state
     │      extensions: [Chat, Pomodoro, …]      │      createSpaceStore({
     │      space.dispatch(appId, action)        │        plugins: space.clientExtensions(),
     │        → SpaceEffect[]（あなたが実行）    │      })
     │              │                            │              │
     │              │                            │    store.onSend(msg) ──┐
     │              │                            │    store.receive(msg) <┘
     │              │                            │              │
     └── @insession/ws-resilient-transport ──────┴──────────────┘
                （サーバーとクライアントの間のソケットはあなたが繋ぐ）
```

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

React で使う場合、入れるバインディングのパッケージはありません。`getState` / `subscribe` が
既に `useSyncExternalStore` の契約を満たしているので、[自分で書く1行](/ja/examples/react-binding/)が
フックの全部です。
