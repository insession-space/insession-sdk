---
title: '@insession/space'
description: ヘッドレスなリアルタイム空間を extension の集合として組み立てる、依存ゼロのエンジン。
---

:::note[英語版が正です]
このページは [英語版](/packages/space/) を訳したものです。英語版は npm に配布される
`README.md` から自動生成されており、内容が食い違う場合は**英語版が正**です。
:::

ヘッドレスなエディタがプラグインの集合として組み立てられるのと同じように、
**ヘッドレスなリアルタイム空間を extension の集合として組み立てる**ためのパッケージです。

WebSocket サーバーとストレージは**あなたが自前で持ちます**。このパッケージが持つのは、
その2つの間にあるもの — **誰が接続しているか**、**どの extension がどの状態スライスを持つか**、
**アクションがどの reducer に届くか**、**タイマーをいつ張り直すか**、
**何をストレージへ書き、何が戻ってくるか** です。

I/O は一切行いません。すべての遷移は **effect 記述子**を返すだけで、実行するのはあなたです。
だからこそ同じ空間が `ws` サーバーの上でも、Durable Object の中でも、ネットワークの無い
テストの中でも、同じように動きます。

- **依存ゼロ。**
- **開いたレジストリ。** 有効な extension 名のグローバルな一覧はありません。渡した extension
  *が*その一覧なので、他人があなたのコードを編集せずに extension を書けます。
- **状態は名前空間化。** 各スライスは自分の extension 名の下にあり、衝突しません。
- **マルチデバイス前提。** 同じアカウントのノートPCとスマホは、2つの接続で1つの入室です。

## インストール

```sh
npm install @insession/space
```

## 使い方

extension は「名前」と「参加する側の面」でできています。サーバーを正とする reducer、
クライアント側の畳み込み、あるいはその両方です。

```ts
import { defineSpaceExtension } from '@insession/space';

const Counter = defineSpaceExtension({
  name: 'counter',
  server: {
    defaultState: () => ({ count: 0 }),
    reduce(state, action) {
      const s = state ?? { count: 0 };
      if (action !== 'inc') return null; // 知らないアクション: 何も起きない
      return { count: s.count + 1 };
    },
  },
});
```

空間を作り、自分のサーバーから駆動します。

```ts
import { createSpace } from '@insession/space';

const space = createSpace({ extensions: [Counter, Chat] });

wss.on('connection', (ws) => {
  const connId = nextId();
  run(space.join({ connId, name, uid }), ws);

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    // `by` は認証済みの文脈から入れる。クライアントのフレームから通さない。
    run(space.dispatch(msg.appId, msg.action, { ...msg.payload, by: name }), ws);
  });

  ws.on('close', () => {
    run(space.leave(connId), ws);
    if (space.isEmpty()) await db.save(spaceId, space.snapshot());
  });
});
```

`effects` が統合面のすべてです。1つの `switch` で全 extension を捌けます。

```ts
function run(effects, ws) {
  for (const effect of effects) {
    switch (effect.type) {
      case 'broadcast':
        sendToEveryone(effect.message, { exclude: effect.excludeSender ? ws : undefined });
        break;
      case 'send-to-sender':
        ws.send(JSON.stringify(effect.message));
        break;
      case 'schedule-timer':
        // その extension に既に張ってあるタイマーを置き換える
        arm(effect.extension, effect.delayMs, () => run(space.fireTimer(effect.extension)));
        break;
      case 'clear-timer':
        cancel(effect.extension);
        break;
      case 'extension':
        // ドメイン固有。発生源が付いている
        handleDomainEffect(effect.extension, effect.effect);
        break;
    }
  }
}
```

`broadcast` と `send-to-sender` は core なので、一度書けば全 extension に効きます。それ以外は
`{ type: 'extension', extension, effect }` で届くので、extension 同士が共通の語彙に合意する
必要はなく、2つの extension が同名の `persist` effect を持っても衝突しません。

### 誰が接続しているか

`members()` はソケット単位（配信先そのもの）、`people()` はアカウント単位に畳んだもの（表示用）です。

```ts
space.members(); // [{ connId: 'a', name: 'Ada', uid: 'u1', presence: 'active' }, { connId: 'b', ... }]
space.people();  // 1件 — 同じ人の2台目だから
```

入退室も同じ規則です。**2台目の接続は2人目の入室ではなく**、2つあるタブの片方を閉じても退室ではない。
1つのソケットが2回閉じても（close イベントと heartbeat タイムアウト）、2回目は何も告知しません。

### 永続化

このパッケージはストレージに触りません。**何を書くかを整え、保存したものを読み戻す**だけです。

```ts
await db.save(spaceId, space.snapshot()); // セッション限りの値は落ちている
space.hydrate(await db.load(spaceId));    // 正規化され、既定値が埋まっている
run(space.armTimers());                   // 再起動で消えたタイマーを張り直す
```

`hydrate` は、このホストが動かしていない extension のスライスに触りません。extension を
一覧から外しても、次の書き込みでその保存済み状態が壊れることはありません。

### クライアント側

extension の client 面は、届いた更新をローカルの表示へ畳みます。`clientExtensions()` は
[`@insession/space-state`](/ja/packages/space-state/) が期待する形で返します。

```ts
const store = createSpaceStore({ ...opts, plugins: space.clientExtensions() });
```

### 状態を自分で持つ

`createSpace` は状態を代わりに持ちます。ホスト側に既に状態の作法がある場合
（DB の行、リビジョンごとのスナップショット、アクターフレームワーク）は、下位の純粋な層も
export されています。`createExtensionRegistry` と参加者関連の関数は、状態を受け取って返すだけです。

```ts
const registry = createExtensionRegistry([Counter, Chat]);
const result = registry.applyAction(slices, 'counter', 'inc');
// result: { state, effects } | null
```

## API

### `defineSpaceExtension(ext)`

推論のための恒等関数。`name` が無い・空なら throw します。

| フィールド | 型 | 備考 |
| --- | --- | --- |
| `name` | `string` | 空間内で一意。状態のキーであり、ブロードキャストの識別子でもある |
| `options` | `unknown` | ホストのために運ぶだけ。このパッケージは読まない |
| `server` | `ExtensionServerFacet` | サーバーを正とする reducer。任意 |
| `client` | `ExtensionClientFacet` | クライアント側の畳み込み。任意 |

#### `ExtensionServerFacet`

| メンバー | 型 | 必須 | 備考 |
| --- | --- | --- | --- |
| `defaultState` | `() => S` | ✅ | 新しいスライス。restore が何も返さないときのフォールバックでもある |
| `reduce` | `(state, action: string, payload?) => S \| { state: S; effects: E[] } \| null` | ✅ | `null` は無効か no-op の意味で、状態変化も effect もブロードキャストも起きない。どちらの返り値の形でも受け付ける |
| `timerDelay` | `(state: S) => number \| null` | — | このスライスの次のイベントまでのミリ秒 |
| `onTimer` | `(state: S) => S \| { state; effects } \| null` | — | そのタイマーが発火したときに呼ばれる |
| `restore` | `(raw: unknown) => S \| null` | — | ストレージから読んだスライスを正規化する。無ければセッション限りとして扱う |
| `persistState` | `(state: S) => S` | — | 書き込む前にセッション限りの値を落とす |

`action` がユニオンではなく `string` なのは意図的です。名前が信用できないワイヤ境界を越えて
届くので、知らないものは `null` に落ちるべきだからです。

#### `ExtensionClientFacet`

| メンバー | 型 | 備考 |
| --- | --- | --- |
| `initLocal` | `(appState) => TLocal` | 入室時点を記録する。**記録だけ**にすること — ここで判定すると再接続のたびに再判定される |
| `onAppState` | `({ local, msg, ctx }) => { local?, lines?, effects? }` | 更新1つをローカルの表示へ畳む |

### `createSpace(options)`

| オプション | 既定 | 備考 |
| --- | --- | --- |
| `extensions` | — | 必須。名前の重複・空で throw |
| `buildSyncMessage` | `{ type: 'space-state', selfId, members, extensions }` | 入室したばかりの接続へ送る |
| `buildJoinMessage` | `{ type: 'member-joined', member, members }` | |
| `buildLeaveMessage` | `{ type: 'member-left', member, members }` | |
| `buildPresenceMessage` | `{ type: 'member-updated', member, members }` | |
| `buildStateMessage` | `{ type: 'app-state', appId, state }` | アクション受理後のブロードキャスト |
| `broadcastOnAction` | `true` | 自分で配信を差配するなら `false` |
| `excludeSenderOnBroadcast` | `false` | 自動ブロードキャストに `excludeSender` を付ける |

メッセージの組み立てが全て注入可能なのは、**ワイヤに乗る封筒はあなたのプロトコルであって、
このパッケージのものではない**からです。

| メソッド | 返り値 | 備考 |
| --- | --- | --- |
| `join({ connId, name, uid?, presence? })` | `SpaceEffect[]` | 入室した接続へは必ず再同期する。告知は最初の接続だけ |
| `leave(connId)` | `SpaceEffect[]` | 告知は最後の接続だけ。未知の id は無音の no-op |
| `setPresence(connId, presence)` | `SpaceEffect[]` | 変化が無ければ空 |
| `dispatch(extension, action, payload?)` | `SpaceEffect[]` | 未知の extension・server 面なし・アクション却下のいずれも空 |
| `fireTimer(extension)` | `SpaceEffect[]` | `schedule-timer` の発火に対して呼ぶ |
| `armTimers()` | `SpaceEffect[]` | 全 extension のタイマーを現在の状態から導き直す |
| `snapshot()` / `hydrate(raw)` | `ExtensionState` / `void` | ストレージの出入り。`hydrate` は参加者に触らない |
| `getState()` / `members()` / `people()` / `isEmpty()` | | |
| `clientExtensions()` | `Array<{ id } & ExtensionClientFacet>` | |

### `SpaceEffect`

| Effect | 意味 |
| --- | --- |
| `{ type: 'broadcast', message, excludeSender? }` | 空間の全員へ送る |
| `{ type: 'send-to-sender', message }` | アクションを起こした本人にだけ送る |
| `{ type: 'schedule-timer', extension, delayMs }` | タイマーを張る。その extension に既にあるものは置き換える |
| `{ type: 'clear-timer', extension }` | 解除する |
| `{ type: 'extension', extension, effect }` | ドメイン固有の effect。発生源が付いている |

受理された extension の遷移は、必ず `schedule-timer` か `clear-timer` のどちらか1つで終わり、
その値は**新しい状態から導き直されます**。無条件に適用することが、pause・restart・stop を
またいでタイマーを正しく保つ唯一の方法です。

### 純粋な層

`createExtensionRegistry(extensions, options?)` — `names` / `has` / `get` / `initState` /
`applyAction` / `timerDelay` / `applyTimer` / `persist` / `restore` / `clientExtensions`。

素の `SpaceMember[]` に対する参加者関数 — `addConnection` / `removeConnection` /
`setPresence` / `findMember` / `hasConnection` / `isFirstConnectionOfUid` /
`isLastConnectionOfUid` / `dedupeByUid`。

## テスト

```bash
npm test
```

## ライセンス

MIT
