---
title: '@insession/ws-resilient-transport'
description: 本番デプロイの都合に合わせて再接続する、依存ゼロの小さな WebSocket トランスポート。
---

:::note[英語版が正です]
このページは [英語版](/packages/ws-resilient-transport/) を訳したものです。英語版は npm に配布される
`README.md` から自動生成されており、内容が食い違う場合は**英語版が正**です。
:::

**依存ゼロ**の小さな（約130行）WebSocket トランスポート。本番デプロイが実際に必要とするやり方で
再接続します。

世の再接続 WebSocket ライブラリの多くは、汎用的なバックオフを提供します。しかし本番で実際に
刺さるのはそこではありません。デプロイのたびに、**全クライアントが同じ瞬間に切断される**という
点です。それらのクライアントには*即座に*戻ってきてほしい（新しいサーバーインスタンスは
ヘルスチェックの裏で既に起動している）。しかし数千のクライアントが同じミリ秒に再接続して
新インスタンスを踏み潰すのは**困ります**。そしてサーバーが接続を完全に閉じたなら、再接続は
本当に止まってほしい。

このトランスポートはまさにそこを扱います:

- **サービス再起動時の高速再接続** — 設定した close code（RFC 6455 の `1012 Service Restart` が
  慣例）なら、バックオフを待たずに短い固定遅延で再接続します。
- **それ以外はジッター付き指数バックオフ**（上限あり）。すべての待ち時間に ±`jitterRatio` の
  ランダム性が乗るので、同時に切られた集団がばらけます（thundering herd を防ぐ）。
- **terminal な close code** — 再接続を完全に止める code の集合（サーバーが「この接続は二度と
  受け付けない」と言った場合）。
- **再開のシグナル** — サービス再起動後の最初の再接続だけ、ハンドshake に
  `resumedFromServiceRestart: true` が渡ります。サーバー側で再入室の副作用（プレゼンスの再配信
  など）を抑制できます。

メッセージ型に対してジェネリックで、既定は JSON。WebSocket 実装・タイマー・乱数はすべて注入
できるので、Node でも決定論的なテストでも動きます。

## インストール

```sh
npm install @insession/ws-resilient-transport
```

ビルド済み ESM パッケージ（`dist/index.js` + `dist/index.d.ts`）として配布され、ランタイム依存は
ありません。

## 使い方

```ts
import { createResilientWebSocket } from '@insession/ws-resilient-transport';

type ClientMsg = { type: string; [k: string]: unknown };
type ServerMsg = { type: string; [k: string]: unknown };

let alive = true;

const transport = createResilientWebSocket<ClientMsg, ServerMsg>({
  url: 'wss://example.com/ws',

  // 接続が開くたび、最初に送られる（認証 / 入室のハンドシェイク）。
  buildOpenMessage: async ({ resumedFromServiceRestart }) => {
    const token = await getIdToken();
    return { type: 'join', token, resume: resumedFromServiceRestart };
  },

  onMessage: (msg) => handle(msg),
  onReconnecting: () => showStatus('再接続中…'),
  isActive: () => alive, // 後片付け時に false を返すと、すべて止まる

  // デプロイの取り決め: RFC 6455 の 1012 = 高速再接続、4001 = terminal。
  serviceRestartCode: 1012,
  terminalCloseCodes: [4001],
});

transport.connect();
transport.send({ type: 'chat', text: 'hi' });

// 後片付け:
alive = false;
transport.close();
```

### サーバー側

インストールするものはありません — これは close code の取り決めにすぎません。グレースフル
シャットダウン時に、各ソケットを自分の `serviceRestartCode` で閉じれば、クライアントは高速な
経路を通ります:

```ts
for (const ws of sockets) ws.close(1012, 'server-restart');
```

新しいインスタンスが接続を受け付けられるようになってから ready を返すヘルスチェックと組み合わせて
ください。高速再接続が生きたサーバーに着地するようにするためです。

## API

`createResilientWebSocket<TSend, TRecv>(options)` → `{ connect, send, close, socket }`

| オプション | 既定値 | 意味 |
| --- | --- | --- |
| `url` | — | 接続先エンドポイント。 |
| `onMessage(msg)` | — | パース済みの受信メッセージごとに呼ばれる。 |
| `buildOpenMessage(ctx)` | — | 接続が開いたときの最初のメッセージを作る。`ctx.resumedFromServiceRestart` が `true` になるのは、サービス再起動後の高速再接続のときだけ。何も送らないなら `null` を返すか throw する。 |
| `onReconnecting()` | — | 再接続がスケジュールされる直前に呼ばれる。 |
| `isActive()` | `() => true` | メッセージ配送前と再接続前に確認されるゲート。 |
| `reconnectDelay` | `500` | 通常の初回再接続のベース待ち時間（ms）。 |
| `maxReconnectDelay` | `15000` | バックオフの上限（ms）。 |
| `serviceRestartCode` | `null` | 「すぐ戻ってこい」を意味する close code。`null` で高速経路を無効化。 |
| `serviceRestartDelay` | `250` | 高速経路の待ち時間（ms）。 |
| `terminalCloseCodes` | `[]` | 再接続を止める close code。 |
| `jitterRatio` | `0.3` | すべての待ち時間に乗るジッターの割合（±）。 |
| `serialize` / `deserialize` | `JSON.stringify` / `JSON.parse` | ワイヤのコーデック。 |
| `WebSocket` | `globalThis.WebSocket` | 使う実装（Node なら `ws` など）。 |
| `timers` | グローバルの set/clearTimeout | テスト用に注入可能。 |
| `random` | `Math.random` | 決定論的なテストのために注入可能な乱数源。 |

_n_ 回目（1始まり）のバックオフは
`min(reconnectDelay · 2^(n−1), maxReconnectDelay)` にジッターを乗せたものです。ただし
`serviceRestartCode` 後の最初の再接続だけは `serviceRestartDelay` を使います。

## テスト

```sh
node --test
```

テストは偽の WebSocket と、注入したタイマー・乱数を使うので完全に決定論的です（実ソケットも
実時間の待ちもありません）。

## 由来

[InSession](https://insession.space) のリアルタイム同期層から切り出したものです。そこでは同期
再生のウォッチパーティをデプロイを跨いで生かし続けています。汎用化にあたっては、プロダクトの
プロトコル型をジェネリクスに置き換え、ハードコードされていた close code を設定へ移しました。

## ライセンス

MIT
