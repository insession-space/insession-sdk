---
title: はじめかた
description: 3つの @insession パッケージが何で、どう噛み合い、最初にどれを取ればよいか。
---

`@insession` SDK は、本番稼働中のリアルタイムアプリから切り出した小さなパッケージ3つです。
互いに独立しているので、1つだけ採用して残りを無視できます。

| パッケージ | 何をするか | ランタイム依存 |
| --- | --- | --- |
| [`@insession/ws-resilient-transport`](/ja/packages/ws-resilient-transport/) | デプロイを跨いで WebSocket を繋ぎ続ける。サービス再起動時は高速再接続、それ以外はジッター付きバックオフ、terminal な close code では再接続を止める。 | なし |
| [`@insession/space-state`](/ja/packages/space-state/) | 共有ルームの状態（メンバー・チャット・プレゼンス・入力中・プラグイン）を、受信メッセージに対する純粋 reducer として持つ。 | なし |
| [`@insession/space-state-react`](/ja/packages/space-state-react/) | store を `useSyncExternalStore` 経由で React に繋ぐ。フック1つ。 | `@insession/space-state`（+ peer に `react`） |

## どう噛み合うか

3つの間にある依存は `space-state-react` → `space-state` の1本だけです。トランスポートは store に
依存**せず**、store もトランスポートに依存**しません**。

```
  あなたのアプリ
     │
     ├── @insession/space-state-react ──> @insession/space-state
     │                                          │
     │                            store.onSend(msg) ──┐
     │                            store.receive(msg) <┘
     │                                          │
     └── @insession/ws-resilient-transport ─────┘
                （この2つを繋ぐのはあなた）
```

この隙間は意図的なものです。store はソケットを開きません。送信メッセージは `onSend` に登録した
ものへ渡すだけで、受信メッセージは `receive` であなたが流し込みます。繋ぐのは3行で済み、
その代わり store は**サーバーもブラウザも無しでテストできる**ままでいられます。

## どれが要るか

- **デプロイのたびに切れる WebSocket を抱えている** → `ws-resilient-transport` だけで足ります。
  ルームや状態のことは何も知りません。
- **共有ルームをモデル化したくて、状態のロジックをテスト可能にしたい** → `space-state` だけを取り、
  トランスポートは今のものを使い続けられます。
- **React アプリで両方** → 3つとも。

## インストール

```sh
npm install @insession/space-state @insession/space-state-react @insession/ws-resilient-transport
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

- [`ws-resilient-transport`](/ja/packages/ws-resilient-transport/) — 再接続オプションの全体と、サーバー側ですべきこと
- [`space-state`](/ja/packages/space-state/) — store の API 全体、effect の一覧、plugin の契約
- [`space-state-react`](/ja/packages/space-state-react/) — フックと、`getServerSnapshot` を渡さない理由
