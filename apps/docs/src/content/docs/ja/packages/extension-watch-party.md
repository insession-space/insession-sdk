---
title: '@insession/extension-watch-party'
description: 依存ゼロの、サーバーを正とする Watch Party 状態機械。動画/音声の同期再生とキュー・履歴を持つ。
---

:::note[英語版が正です]
このページは [英語版](/packages/extension-watch-party/) を訳したものです。英語版は npm に配布される
`README.md` から自動生成されており、内容が食い違う場合は**英語版が正**です。
:::

**依存ゼロの、サーバーを正とする Watch Party 状態機械。** 1つの「今流れているもの」（YouTube 動画
または SoundCloud トラック）を、キューと再生履歴つきでルーム全員に同期します。

「みんなが同じ動画を同時に見る」を作るのは、見た目より罠が多いものです。毎秒ポジションを配信する
のは帯域の無駄なうえにズレは消えず、キューへの追加は1件でも解決が遅れると送信順を簡単に失い、
「動画が終わった」は**全員のクライアントから同時に**届くのでちょうど1回だけ処理しなければなりま
せん。このパッケージは、その配管を全部取り除いた状態機械そのものです:

- **`reduce` は純関数。** `(state, action, payload) => { state, effects } | null`。I/O は一切
  しません — `null` は「このアクションを無視する」という意味です（例: 不正なペイロード、空の
  `seek` のような正当な no-op）。
- **副作用はコールバックではなく記述子で返す。** `broadcast`/`persist`/`fetchTitle` のような
  関数を受け取って内部で呼ぶのではなく、`reduce` は何が起きるべきかを表す型付きの
  `WatchPartyEffect` オブジェクトの配列を返します。実行するのはホスト側です。これにより
  `reduce` は完全に同期的でテストしやすいまま保たれます — 詳細は下記
  [Effects](#効果effects) 参照。
- **ウォールクロックのティックが無い。** 再生中は、最後に記録した位置とタイムスタンプから
  外挿して位置を求めます（`currentPosition`）。サーバーは実際の再生・一時停止・シーク・ロード
  イベントにだけ反応すればよく（加えて、バックグラウンドから復帰したクライアントが追いつくための
  `request-sync` を時々処理するだけです）。
- **すべての入力に上限と検証がある。** 動画/トラック id・キュー長・メンバーごとのキュー上限・
  タイトル/URL の長さ — すべてに上限があり、悪意ある/バグのあるクライアントが共有 state を
  際限なく膨らませたり、配信に不正な値を紛れ込ませたりできません。
- **`restore` は設計として防御的。** ストレージ層が返してきたものを — 壊れた JSON であっても —
  そのまま渡せば、上限が適用された安全な state が返ります。再生状態は常に停止状態で戻ります
  （再起動後、もう有効ではない時計を基準に途中から再開するのではなく）。

## このパッケージが意図的にやらないこと

これは*同期*のレイヤーであって、メディアクライアントではありません。**依存ゼロ**（HTTP クライア
ントすら持たない）なので、次のことはできませんし、しません:

- 動画/トラックの検索、oEmbed によるタイトル解決、尺の取得、いずれのプロバイダの API とも通信
  しません。タイトルや尺が不明なとき、`reduce` は `resolve-metadata` エフェクトを発行してホストに
  探してもらいます — 詳細は
  [タイトルと尺を解決する](#タイトルと尺を解決する) 参照。
- 何もデータベースへ永続化しませんし、何も WebSocket（や他の transport）へ送信しません。それら
  の操作は effect として記述するだけです。
- 投稿された `mediaUrl`/`thumbnail` が信頼できる場所（許可済みの SoundCloud ホスト等）を指して
  いるかを検証しません。これはこのパッケージが持たないプロバイダ固有のポリシーです — ペイロード
  が `reduce` に届く前に、自分で検証してください。
- 共有の「おまかせ再生（mix）」機能が有効なときに候補を選びません。このパッケージが保証するのは
  「そのような機能がこのパッケージに邪魔されずキューより優先できる」ことだけです — 詳細は
  [ホスト側の「mix」機能に譲る](#ホスト側のmix機能に譲る) 参照。

## インストール

```sh
npm install @insession/extension-watch-party
```

ESM（`dist/index.js`）と CommonJS（`dist/index.cjs`）の両方のエントリポイントに `dist/index.d.ts` の
型を添えたビルド済みパッケージとして配布され、ランタイム依存はありません。

:::note[0.4.0 で改名しました]
`@insession/plugin-watch-party-state` から改名しました。旧名は npm 上で deprecated です。
API は下記の `watchPartyExtension` が増えた以外に変更はありません。
:::

## スペースに載せる

[`@insession/space`](/ja/packages/space/) でスペースを組み立てているなら、組み込みは1行です。
extension が自分の名前・reducer・永続化の規則をまとめて持ち、effect には発生源が付いて届きます。

```ts
import { createSpace } from '@insession/space';
import { watchPartyExtension } from '@insession/extension-watch-party';

const space = createSpace({ extensions: [watchPartyExtension({ pickShuffleIndex })] });

space.dispatch('watch-party', 'load-video', { videoId, by: name });
// -> [broadcast, { type: 'extension', extension: 'watch-party', effect: { type: 'persist-playback', ... } }, clear-timer]
```

`createWatchParty` が受け取るオプションはすべてここでも渡せます。加えて `{ name }` で
別のキーを占有できます。

このオブジェクトを作るのに `@insession/space` から何も import していません。あちらの
`SpaceExtension` を**構造的に**満たしているだけなので、このパッケージは依存ゼロのままです。

## 使い方

```ts
import {
  createWatchParty,
  type WatchPartyEffect,
  type WatchPartyState,
} from '@insession/extension-watch-party';

const watchParty = createWatchParty({
  // 任意: シャッフル有効時に候補をどう選ぶか。省略するとシャッフルは無効化されたのと同じに
  // なります（常に FIFO）。下記「シャッフル」参照。
  pickShuffleIndex: (items, currentVideoId) =>
    Math.floor(Math.random() * items.length),
});

// ルームごとに WatchPartyState を1つ持つ場所。例えば Map<roomId, WatchPartyState>。
let state: WatchPartyState = watchParty.defaultState();

// クライアントのアクションが transport（WebSocket 等）経由で届く。`by`/`addedBy` は操作した
// メンバーを指し、それをどう導くか（セッション・認証…）はあなたの判断。
function onClientAction(action: string, payload: unknown) {
  const result = watchParty.reduce(state, action, payload as Record<string, unknown>);
  if (!result) return; // 無効、または no-op — 何も変わっていないので実行するものも無い
  state = result.state;
  for (const effect of result.effects) runEffect(effect);
}

function runEffect(effect: WatchPartyEffect) {
  switch (effect.type) {
    case 'broadcast':
      broadcastToRoom(effect.message, { excludeSender: effect.excludeSender });
      break;
    case 'send-to-sender':
      sendToSender(effect.message);
      break;
    case 'persist-playback':
      db.savePlaybackState(roomId, effect.videoId, effect.isPlaying, effect.position).catch(() => {});
      break;
    case 'persist-media':
      db.saveMedia(roomId, effect.provider, effect.mediaUrl, effect.thumbnail).catch(() => {});
      break;
    case 'resolve-metadata':
      // 好きな方法（oEmbed・プロバイダの API・キャッシュ…）でタイトル/尺を取得し、
      // 結果を下記のように送り返す。
      resolveTitleAndDuration(effect).then(({ title, durationSec }) => {
        const patched = watchParty.reduce(state, 'resolve-metadata', {
          uid: effect.uid,
          kind: effect.kind,
          title,
          durationSec,
        });
        if (!patched) return;
        state = patched.state;
        for (const e of patched.effects) runEffect(e);
      });
      break;
  }
}

// ルーム起動時・最初の入室時にストレージから読む。
function loadFromDb(raw: unknown) {
  state = watchParty.restore(raw) ?? watchParty.defaultState();
}
```

### アクション

`reduce(state, action, payload)` は次の `action` 文字列を受け付けます:

| アクション | ペイロード | 効果 |
| --- | --- | --- |
| `load-video` | `{ videoId, provider?, mediaUrl?, thumbnail?, title?, durationSec?, by? }` | アイテムを即座にロードして再生する（位置0）。履歴に1件記録する。 |
| `play` | `{ position?, by? }` | 再生を再開する。`position` が不正/未指定なら、0へ巻き戻るのではなく現在の（外挿済みの）位置を維持する。 |
| `pause` | — | **常に no-op。** [なぜ `pause` は何もしないのか](#なぜ-pause-は何もしないのか) 参照。 |
| `seek` | `{ position, by? }` | `position` へジャンプする。`position` が不正なら何もしない（配信も永続化もしない） — 壊れたシーク先に安全なフォールバックは無い。 |
| `video-ended` | `{ videoId, shuffleEnabled?, mixActive? }` | 全クライアントから届く。現在のアイテムと `videoId` が一致したときだけ処理する。キューを進めるか、`mixActive` なら完全に何もしないか、次が無ければ再生を凍結する。[ホスト側の「mix」機能に譲る](#ホスト側のmix機能に譲る) 参照。 |
| `request-sync` | — | state は変わらない。現在位置を積んだ `send-to-sender` エフェクトを1つ返す（バックグラウンドから復帰したクライアントがすぐ追いつくため）。 |
| `queue-add` | `{ videoId, provider?, mediaUrl?, thumbnail?, title?, durationSec?, addedBy?, addedByUid?, maxQueueLength?, maxPerUser?, maxDurationSec?, shuffleEnabled? }` | 送信順を保ってキューへ追加する（理由はソース中の `insertByAddSeq` を参照）。何も再生されていなければ即座に自動再生する。 |
| `queue-remove` | `{ uid }` | id で1件削除する。見つからなければ no-op。 |
| `queue-clear` | — | キューを空にする。既に空なら no-op。 |
| `queue-reorder` | `{ uid, toIndex, shuffleEnabled? }` | 1件を移動する。`shuffleEnabled` の間は完全に無視される（再生順が配列順と一致しないシャッフル中は並べ替えに意味が無いため）。 |
| `queue-play` | `{ uid, by?, byUid? }` | 指定したキューアイテムを、位置に関わらず即座に再生する。 |
| `queue-play-next` | `{ by?, byUid?, shuffleEnabled? }` | キューを進める（FIFO、または `shuffleEnabled` のとき `pickShuffleIndex` 経由）。キューが空なら no-op。 |
| `resolve-metadata` | `{ uid, kind?, title?, durationSec? }` | ホストが解決したタイトル/尺を、`uid` に一致するキュー（`kind: 'queue'`。既定値）または履歴（`kind: 'history'`）のアイテムへ適用する。既に分かっているフィールドは絶対に上書きしない。対象アイテムが既に無ければ（再生済み/削除済み/履歴から溢れた）no-op。 |

これ以外の `action` 文字列はすべて `null` を返します。ペイロードはワイヤ越しに届くため、あらゆる
フィールドは信用できないものとして使う直前に検証されます — `reduce` は不正な入力で例外を投げません。

一部のペイロードフィールド（`shuffleEnabled`・`mixActive`・`maxQueueLength`・`maxPerUser`・
`maxDurationSec`）は**ワイヤデータではなくホストが信頼する設定値**です。ホストは自分のルーム/
スペースの設定からこれらを読み、`reduce` を呼ぶ前にペイロードへ組み込むことを想定しています —
`by`/`addedBy` を、クライアント申告の名前ではなく認証済みセッションから導くのと同じ扱いです。

### 効果（Effects）

`reduce` は I/O を一切行いません。`{ state, effects }` を返し、`effects` は `WatchPartyEffect`
記述子のリストです:

```ts
type WatchPartyEffect =
  | { type: 'broadcast'; message: unknown; excludeSender?: boolean }
  | { type: 'send-to-sender'; message: unknown }
  | { type: 'persist-playback'; videoId: string | null; isPlaying: boolean; position: number }
  | { type: 'persist-media'; provider: WatchPartyProvider | null; mediaUrl: string | null; thumbnail: string | null }
  | {
      type: 'resolve-metadata';
      uid: string;
      kind: 'queue' | 'history';
      videoId: string;
      provider: WatchPartyProvider;
      mediaUrl: string | null;
      by: string | null;
      byUid: string | null;
      durationSec: number | null;
    };
```

ホストは `result.effects` をループし、自分の transport/ストレージに対して1つずつ実行します —
上記の `runEffect` の例を参照してください。これは `@insession/space-state` の `reduceSpace` が
採っている effect 記述子の流儀と同じです: reducer が「何が起きるべきか」を記述し、ホストが
「どう実行するか」を決めます。

`broadcast`/`send-to-sender` のメッセージは、内部専用フィールド（キューアイテムの
`addedByUid`/`addSeq`、履歴アイテムの `byUid`）を既に取り除いた状態になっています —
ホストは `effect.message` をそのままワイヤへ流すだけでよく、自分でサニタイズし忘れる心配は
ありません。

### タイトルと尺を解決する

このパッケージはタイトルや尺を自分では取得しません — HTTP クライアントを持たず、あなたの
プロバイダの API について何の意見も持ちません。`queue-add` や再生遷移（`load-video`・
`queue-play`・自動進行…）がアイテムのタイトルをまだ知らないとき、`reduce` はそれを調べるのに
必要な情報（`videoId`・`provider`・`mediaUrl`）に加えて、どのキュー/履歴エントリを更新すべきかを
特定する `uid`/`kind` の組を持つ `resolve-metadata` エフェクトを発行します。解決できたら、同じ
`uid`/`kind` を添えてアクション `'resolve-metadata'` で `reduce` をもう一度呼んでください:

```ts
watchParty.reduce(state, 'resolve-metadata', {
  uid: effect.uid,
  kind: effect.kind, // 'queue' | 'history'
  title: 'Never Gonna Give You Up',
  durationSec: 213,
});
```

既に分かっているタイトル/尺を上書きすることは決してありません（2つの解決が競合した場合や、
別経路で既に解決済みだった場合に備えて）。また、解決が返ってきた時点で対象アイテムが既に消えて
いれば（再生済み・削除済み・上限のある履歴から溢れた）no-op になります — これは移植元のアプリが
持つ、行方不明になったメタデータ取得への同じ「肩をすくめる」fail-open の挙動と同じです。

### ホスト側の「mix」機能に譲る

一部のホストは Watch Party の上に「おまかせ再生（mix / auto-DJ）」機能を重ねます（プールから
ランダムに次のトラックを選び、手動でキューに積まなくてもパーティを続ける） — たいてい LLM や
レコメンド API、ユーザーのライブラリが必要になるため、このパッケージの対象外です。ただし動画が
終わったとき、その機能は素朴なキューより優先されなければならず、かつこのパッケージ自身のキュー
進行とは絶対に競合してはいけません。

`video-ended` のペイロードには、まさにこのための `mixActive` フラグがあります:

```ts
watchParty.reduce(state, 'video-ended', {
  videoId: endedVideoId,
  mixActive: yourMixFeature.hasNextTrack(myRoom),
});
```

`mixActive` が `true` のとき、`reduce` は**何もしません** — キューも進めず、凍結もせず、
effect も出しません。その時点から先は mix 機能が全てを引き受けます。候補が無かった場合の挙動も
含めてです。

これは `createWatchParty` へ注入する関数ではなく、素朴なペイロードのフラグです（対照的に
`pickShuffleIndex` はファクトリレベルで注入します）。理由は、mix が有効かどうかがルームごとに
動的な状態であり、ある `video-ended` の呼び出しと次の呼び出しの間でオン/オフが切り替わりうる
からです。ファクトリレベルのコールバックだとその瞬間に古くなってしまいますが、ホストは
`reduce` を呼ぶと決めた時点で答えを同期的に知っているので、そのまま伝えるのが最もシンプルです。

### なぜ `pause` は何もしないのか

これは実装漏れではなく、意図的な設計判断です。`pause` は**押した本人のクライアントにだけ**適用
されます — 共有サーバー state（`isPlaying`・`position`）には触れず、誰にも配信されません。
`play` と `seek` はルーム全体に影響するので、`pause` だけ何もしないのは一見矛盾しているように
見えますが、自分のプレーヤーを一時停止する（玄関のドアに出るため等）ことが、ルーム全員の動画を
止めてよい理由にはなりません。他のあらゆるクライアント — 一時停止した本人の再接続後の state を
含めて — は共有の位置のまま再生し続けます。このアクションは受け付けられます（ホストがクライアント
側で特別扱いしなくて済むように）が、常に `null` を返します。

### シャッフル

Watch Party のシャッフルは「現在再生中のアイテムだけを避ける」という意味で、「全員のキュー
エントリが1回再生されるまで繰り返さない」ではありません。このパッケージはこの選択アルゴリズム
自体を実装せず、`createWatchParty` を呼ぶときに `pickShuffleIndex` として注入してもらいます。
これは意図的です: もしあなたのアプリが Watch Party と別の「リストからランダムに選ぶ」機能で
1つのシャッフル実装を共有している（「ランダム」の意味をどこでも揃えるため）のであれば、このパッ
ケージへ2つ目の実装を持ち込むと両者が食い違っていく可能性があります。その保証が不要なら、
与えられた `items` への有効な index を返す任意の関数で構いません。例えば:

```ts
pickShuffleIndex: (items) => Math.floor(Math.random() * items.length)
```

`pickShuffleIndex` を省略すればシャッフルは単に不活性になります — ペイロードの `shuffleEnabled`
は無視され、キューは常に FIFO で進みます。

## API

| エクスポート | シグネチャ | 意味 |
| --- | --- | --- |
| `createWatchParty` | `(options?: { pickShuffleIndex?, autoAdvanceBy? }) => WatchPartyStateApi` | API を組み立てる。両方のオプションとも任意。 |
| `defaultState()` | `() => WatchPartyState` | 空のルーム: 何もロードされておらず、キュー/履歴も空。トップレベルの export としても利用可能（`createWatchParty` のオプションに依存しない）。 |
| `currentPosition(state)` | `(state: WatchPartyState) => number` | 今この瞬間の再生位置。再生中はウォールクロックで外挿する。トップレベルの export としても利用可能。 |
| `.reduce` | `(state, action, payload?) => { state, effects } \| null` | アクションを1つ適用する。`null` は「無視する」（無効または no-op）。 |
| `.restore` | `(raw: unknown) => WatchPartyState \| null` | ストレージから読んだ state を正規化する。`null` になるのはオブジェクトでない入力のときだけ。再生状態は常に停止状態で戻る。 |

`createWatchParty` のオプション:

- `pickShuffleIndex?: (items, currentVideoId) => number` — [シャッフル](#シャッフル) 参照。
- `autoAdvanceBy?: string` — 特定の操作者無しに再生が始まったアイテムに刻む `by` の値
  （空のルームへの最初の `queue-add`、または `video-ended` のキュー進行）。既定値は `'queue'`。
  「キューが自動で進めた」と「メンバーが再生を押した」をUI側で区別できるようにする — 実際の
  メンバー名と紛れない独自の値が欲しければ指定してください。

### 型

`WatchPartyState`、`WatchPartyProvider`、`WatchPartyQueueItem`、`WatchPartyHistoryItem`、
`WatchPartyAction`、`WatchPartyPayload`、`WatchPartyEffect`、`CreateWatchPartyOptions`、
`WatchPartyStateApi` はすべてエクスポートされています。`reduce` の `action` 引数が
`WatchPartyAction` ではなく `string` なのは意図的です — ここはアクション名が信用できない入力
として届くワイヤ境界であり、既知の集合から外れたものはすべて `null` に落ちます。

### キューを永続化するなら、アイテム id は自分で用意する

キューのアイテムは既定でカウンタベースの `uid`（`q1`、`q2`、…）を持ちます。これはキュー全体が
メモリ上にある間だけ安全です — 保存したキューを再ロードするとカウンタが0から再開するため、
復元されたアイテムと新規追加のアイテムが id を共有してしまいます。

キューを永続化するなら、保存先の id をそのまま渡してください:

```ts
const uid = crypto.randomUUID(); // またはデータベースの主キー

watchParty.reduce(state, 'queue-add', { videoId, uid });
// 以降: reduce(state, 'queue-remove', { uid }) は同じ行を指す
```

`queue-remove` / `queue-reorder` / `queue-play` が受け取るのも同じ `uid` なので、
ストレージとこの状態機械が常に同じアイテムを指し続けます。

### メタデータを先に解決するときも、送信順を保つ

ホスト側が `reduce` を呼ぶ前に何か（尺の上限チェックのための duration 取得や、タイトルの
取得など）を await していると、連続して送られた2つの add が逆順で届くことがあります —
先に終わった lookup の方が先に `reduce` に到達するためです。すると、実際に送られた順序に対して
キューの見た目が入れ替わってしまいます。

await する**前**に到着順を同期的に記録し、`addSeq` として渡してください:

```ts
// await の前に、到着順を同期的に記録する。
seq += 1;
const addSeq = seq;

const durationSec = await lookUpDuration(videoId); // 順序が入れ替わりうる

const out = watchParty.reduce(state, 'queue-add', { videoId, durationSec, addSeq });
```

`reduce` は末尾に追加するのではなく `addSeq` でアイテムを差し込むので、送信順が保たれます。
`addSeq` を省略すると呼び出し時点の値が割り当てられます — 先に await しないホストであれば
それで問題ありません。

## テスト

```sh
node --test
```

すべてのテストは、時間に依存しない入力を使うか、その間 `Date.now()` を固定するかのどちらかなので、
スイート全体が完全に決定論的です — 実時計も、実時間の待ちもありません。

## ライセンス

MIT
