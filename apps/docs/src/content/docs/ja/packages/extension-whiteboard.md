---
title: '@insession/extension-whiteboard'
description: 依存ゼロの、サーバーを正とするホワイトボード状態機械。自由描画キャンバスと「お絵かき伝言ゲーム」が同居する。
---

:::note[英語版が正です]
このページは [英語版](/packages/extension-whiteboard/) を訳したものです。英語版は npm に配布される
`README.md` から自動生成されており、内容が食い違う場合は**英語版が正**です。
:::

**依存ゼロの、サーバーを正とするホワイトボード状態機械。** 共有の自由描画キャンバス（strokes +
shapes）に、「お絵かき伝言ゲーム」の relay を任意で載せられます。

共有ホワイトボード（「みんなが同じキャンバスにライブで描く」）は、微妙に間違えやすいものです。
strokes の配列に上限が無ければ際限なく増え続け、悪意あるペイロードは何メガバイトも共有 state に
紛れ込ませられ、投稿された画像 URL はチェックする仕組みが無ければインターネット上のどこでも
指せてしまいます。その上に載る伝言ゲームには、フェーズのタイミング・手番・誰かが最後まで提出しな
かったときの扱いという、それ自体の不具合の種があります。

このパッケージは、その配管を全部取り除いた状態機械そのものです:

- **`reduce` は純関数。** `(state, action, payload) => { state, effects } | null`。I/O をせず、内部で
  タイマーを張ることもありません。`null` は「このアクションを無視する」という意味です（例: 上限を
  超えた shape の追加、空の `clear`）。`effects` はあなたが実行すべき書き込みを記述します
  （下記参照）。
- **確定した strokes/shapes だけを扱う。** 描画中（ライブのカーソルプレビュー）は意図的に対象外
  です — それは自分で作る、低遅延で検証しない別チャネルの役割です。このモジュールが気にするのは、
  描き終わった strokes/shapes だけです。
- **すべての入力に上限がある。** stroke 数・stroke あたりの点数・shape 数・shape のテキスト長・
  shape のシリアライズ後サイズ、すべてに上限を設けているので、悪意あるクライアントやバグのある
  クライアントが共有 state を際限なく膨らませることはできません。
- **relay ゲームは小さなフェーズ機械。** `prompt → draw → guess → ... → album` と進み、この SDK の
  他のタイマーと同じ形で駆動します — `timerDelay`/`onTimer` による期限切れに、クライアント自身の
  自動提出が間に合うための猶予期間を添えて。
- **`restore` は設計として防御的。** ストレージ層が返してきたものを — 壊れた JSON であっても —
  そのまま渡せば、上限が適用された安全な state が返ります。進行中の relay ゲームは再起動を
  生き延びません（保存済み再生位置について SDK の他の箇所で下した判断と同じ理由です — 再開する
  なら、もう有効ではない時計を基準に途中から動かすのではなく、止まった状態に戻すべきだからです）。
- **パッケージ全体で唯一「純粋でない」ものは `Date.now()`。**

## なぜプレーンな export ではなくファクトリなのか

投稿された絵の画像 URL（`submit-drawing` アクション）を受け取るということは、その URL が信用できる
かどうかを判断する必要があるということです。このパッケージは、あなたのストレージのバケット・
ドメイン・署名方式を知りようがないので、推測しません — 代わりに述語を渡します:

```ts
import { createWhiteboardState } from '@insession/extension-whiteboard';

const whiteboard = createWhiteboardState({
  isOwnImageUrl: (url) => url.startsWith('https://cdn.example.com/uploads/'),
});
```

`isOwnImageUrl` は**必須**です。「全部受け入れる」という既定値は用意していません — それでは渡し
忘れたホストが、気づかないまま任意の外部 URL を共有 state に受け入れてしまいます。これはまさに、
悪用されるまで気づかれない類の穴です。値が無い、または関数でない場合、`createWhiteboardState` の
呼び出し時点で即座に例外を投げます。

戻り値のオブジェクトは5つの関数（`defaultState`、`reduce`、`timerDelay`、`onTimer`、`restore`）を
すべてまとめて持っているので、どれが述語を必要としてどれがそうでないかを覚えておく必要はありません
（実際に述語を読むのは `reduce` だけで、`submit-drawing` アクション経由です）。`defaultState` は
トップレベルの named export としても利用できます — 実装を見なくても `isOwnImageUrl` に依存しない
ことが明らかな唯一の関数だからです。フォールバック/初期値だけが要る場合に便利です。

## インストール

```sh
npm install @insession/extension-whiteboard
```

ESM（`dist/index.js`）と CommonJS（`dist/index.cjs`）の両方のエントリポイントに `dist/index.d.ts` の型を
添えたビルド済みパッケージとして配布され、ランタイム依存はありません。

:::note[0.2.0 で改名しました]
`@insession/plugin-whiteboard-state` から改名しました。旧名は npm 上で deprecated です。
API は下記の `whiteboardExtension` が増えた以外に変更はありません。
:::

## スペースに載せる

[`@insession/space`](/ja/packages/space/) でスペースを組み立てているなら、組み込みは1行です。
extension が自分の名前・reducer・リレーのタイマー・永続化の規則をまとめて持っています。

```ts
import { createSpace } from '@insession/space';
import { whiteboardExtension } from '@insession/extension-whiteboard';

const space = createSpace({
  extensions: [whiteboardExtension({ isOwnImageUrl: (url) => url.startsWith(MY_BUCKET) })],
});

space.dispatch('whiteboard', 'add-stroke', { stroke }); // -> [broadcast, clear-timer]
```

`isOwnImageUrl` がここでも必須なのは `createWhiteboardState` と同じ理由です（後述）。
`{ name }` を渡せば別のキーを占有できます。

このオブジェクトを作るのに `@insession/space` から何も import していません。あちらの
`SpaceExtension` を**構造的に**満たしているだけなので、このパッケージは依存ゼロのままです。

## 使い方

```ts
import {
  createWhiteboardState,
  type WhiteboardState,
} from '@insession/extension-whiteboard';

const whiteboard = createWhiteboardState({
  isOwnImageUrl: (url) => url.startsWith('https://cdn.example.com/uploads/'),
});

// ボードごとに WhiteboardState を1つ持つ場所。例えば Map<boardId, WhiteboardState>。
let state: WhiteboardState = whiteboard.defaultState();

// クライアントのアクションが transport（WebSocket 等）経由で届く。`by` は操作したメンバーを
// 指し、それをどう導くか（セッション・認証…）はあなたの判断。
function onClientAction(action: string, payload: unknown) {
  const next = whiteboard.reduce(state, action, payload as Record<string, unknown>);
  if (!next) return; // 無効、または no-op — 何も変わっていないので配信するものも無い
  state = next;
  broadcastToBoard({ type: 'extension-whiteboard', state });
  scheduleRelayTimer();
}

// relay ゲームのフェーズ遷移は自分のタイマー（setTimeout、ジョブキュー…）で駆動する。
let relayTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleRelayTimer() {
  clearTimeout(relayTimer);
  const delay = whiteboard.timerDelay(state);
  if (delay === null) return; // relay ゲームが動いていない — 張るものは無い
  relayTimer = setTimeout(() => {
    const next = whiteboard.onTimer(state);
    if (!next) return;
    state = next;
    broadcastToBoard({ type: 'extension-whiteboard', state });
    scheduleRelayTimer();
  }, delay);
}

// ボード起動時・最初の入室時にストレージから読む。
function loadFromDb(raw: unknown) {
  state = whiteboard.restore(raw) ?? whiteboard.defaultState();
}
```

描画中の stroke（まだ指/ペンが離れていないライブプレビュー）はこの状態機械の対象外です — 自分の
transport でそのまま検証も保存もせずに配信し、ポインタが離れたタイミングで初めて `reduce` の
`add-stroke` に渡してください。

### アクション

`reduce(state, action, payload)` は次の `action` 文字列を受け付けます:

| アクション | ペイロード | 効果 |
| --- | --- | --- |
| `add-stroke` | `{ stroke }` | 確定した自由描画の stroke を追加する（同じ id なら置き換え）。2000本を超えると古いものから捨てられる。 |
| `erase` | `{ ids }` | id で strokes を削除する。1つも一致しなければ no-op。 |
| `clear` | — | strokes と shapes の**両方**を空にする（strokes だけ空にする「clear」だと shapes が残ってしまうため）。既に空なら no-op。 |
| `add-shape` | `{ shape }` | shape（rectangle/ellipse/connector/text/sticky/…）を追加する（同じ id かつ同じ type なら置き換え）。500件を超える追加、または同じ id を別の type で使い回そうとした場合は拒否される。 |
| `update-shape` | `{ id, patch }` | shape を部分更新する。`id`/`type` は patch では変更できない。patch が空/無効なら no-op。 |
| `remove-shape` | `{ ids }` | id で shapes を削除する。1つも一致しなければ no-op。 |
| `set-mode` | — | 常に no-op。古いクライアントとの互換のためだけに受け付けている。ここで `game: null` を許すと、進行中の relay ゲームを誰でも黙って破棄できてしまうため。 |
| `join-game` | `{ by }` | relay ゲームのロビーに参加する（最初の join で遅延生成される）。満員（8人）またはゲーム開始後は拒否される。 |
| `leave-game` | `{ by }` | ロビーから抜ける。`lobby` フェーズの間だけ有効。 |
| `start-game` | — | relay ゲームを開始する（2人以上必要）。`prompt` フェーズへ進む。 |
| `reset-game` | — | `album` から新しいロビーへ戻る。プレイヤーは引き継がれる。 |
| `submit-prompt` | `{ by, text }` | `prompt` フェーズ中にお題を提出する。 |
| `submit-drawing` | `{ by, imageUrl }` | `draw` フェーズ中に絵を提出する。`imageUrl` は `isOwnImageUrl` を満たす必要がある。 |
| `submit-guess` | `{ by, text }` | `guess` フェーズ中に答えを提出する。 |

これ以外の `action` 文字列はすべて `null` を返します。ペイロードはワイヤ越しに届くため、あらゆる
フィールドは信用できないものとして使う直前に検証されます — `reduce` は不正な入力で例外を投げず、
代わりに `null` を返します。

## API

| エクスポート | シグネチャ | 意味 |
| --- | --- | --- |
| `createWhiteboardState` | `(options: { isOwnImageUrl: (url: string) => boolean }) => WhiteboardStateApi` | API を組み立てる。`isOwnImageUrl` が無い、または関数でなければ例外を投げる。 |
| `defaultState()` | `() => WhiteboardState` | 空の free モードで、relay ゲームも無い state。トップレベルの export としても利用可能（上記参照）。 |
| `.reduce` | `(state, action, payload?) => { state, effects } \| null` | アクションを1つ適用する。`null` は「無視する」（無効または no-op）。 |
| `.timerDelay` | `(state) => number \| null` | 現在の relay フェーズが（猶予期間込みで）終わるまでのミリ秒。relay ゲームが動作中でなければ `null`。 |
| `.onTimer` | `(state) => { state, effects } \| null` | `timerDelay` が経過したときに呼ぶ。未提出のプレイヤーにプレースホルダーを埋めてからラウンドを進める。ゲームが無ければ `null`。 |
| `.restore` | `(raw: unknown) => WhiteboardState \| null` | ストレージから読んだ state を正規化する。`null` になるのはオブジェクトでない入力のときだけで、それ以外は strokes/shapes がフィルタ・上限適用され、`mode` は常に `'free'`、`game` は常に `null` になる。 |

### Effects

このパッケージの中で、セッションを跨いで残す価値があるのは完成した relay ゲームだけです。
album（誰が何をどの順で描いたか）こそが報酬であり、全員が退室すると消えてしまいます。

| Effect | いつ |
| --- | --- |
| `{ type: 'persist-relay-history', players, chains }` | `reduce` または `onTimer` のどちらかから relay が album に到達したとき。 |
| `{ type: 'relay', payload }` | ライブ描画のフレーム（`relay` アクション）。**何も変わっていない** — 送信者以外の全員へ転送し、保存はしない。 |

`relay` は **state を返さず `{ effects }` だけを返す**唯一のアクションです。ライブプレビューは
ポインタが動くたびにフレームを流します。見ている人へ転送する価値はありますが、1秒後には
何の価値もありません。通常の経路を通すと、フレームごとに盤面を永続化し、broadcast し、
relay フェーズのタイマーを張り直すことになります。**最後のこれが厄介で、切れるはずの
カウントダウンが永久に切れなくなります。**

`payload` は**意図的に不透明**です。フレームの中身が何か —— 途中までのストローク、精度を
落とした盤面全体、カーソル位置 —— は、あなたの描画クライアントとレンダラの間の取り決めで、
その UI が機能を増やすたびに変わります。このパッケージは中身に触れずそのまま通すので、
ワイヤ上の形はあなたが決めてください。このパッケージが決めているのは
「ホワイトボードが relay を受け付ける」ということだけです。

`persist-relay-history` は album への遷移の辺で**ゲーム1回につきちょうど1回**だけ発火します。
再戦（`reset-game` でロビーに戻ってから再び遊ぶ）は自分自身の effect を1回出します。
free-draw の編集は effect を出しません。

```ts
const result = board.reduce(state, action, payload);
if (result) {
  state = result.state;
  for (const effect of result.effects) {
    db.insertRelayHistory(spaceId, { finishedAt: Date.now(), ...effect });
  }
}
```

### 型

`WhiteboardState`、`WhiteboardMode`、`WhiteboardStroke`、`WhiteboardStrokePoint`、
`WhiteboardStrokeStyle`、`WhiteboardShape`、`WhiteboardShapeType`、`WhiteboardShapeStyle`、
`AnchorType`、`PathType`、`ArrowHead`、`RelayPhase`、`RelayGame`、`RelayChainEntry`、
`WhiteboardAction`、`WhiteboardPayload`、`WhiteboardStateApi` はすべてエクスポートされています。
`reduce` の `action` 引数が `WhiteboardAction` ではなく `string` なのは意図的です — ここはアクション
名が信用できない入力として届くワイヤ境界であり、既知の集合から外れたものはすべて `null` に落ちます。

### なぜ描画中の stroke はこのモジュールの関心事ではないのか

共有 state に載るべきなのは**確定した** stroke（ポインタが離れたもの）だけです — 検証・永続化され、
後から参加した人も含め全員に配信されます（`restore` 経由）。描画中のライブプレビューは高頻度かつ
使い捨てで、ポインタの移動のたびに `reduce`・ストレージ・state 全体のブロードキャストを通すのは
無駄で不要です。自分の transport で検証も保存もせずに配信し、stroke が確定した時点でだけ
`reduce` の `add-stroke` を呼んでください。

### なぜ `clear` は shapes も空にするのか

「ボードをクリアする」はボードが空に戻ることを意味します — strokes だけ消して shapes を残す
`clear` は、その期待を静かに裏切ってしまいます。

### なぜ `timerDelay` に猶予期間があるのか

クライアントは、自分のローカルなカウントダウンがゼロに達した瞬間に、途中まで入力したお題/絵/答えを
自動提出しますが、その自動提出はネットワークを渡る時間を要します。もし `onTimer` の「未提出者に
プレースホルダーを埋める」処理がフェーズの名目上の長さが経過した瞬間に発火してしまうと、既に
送信中だった提出との競争に勝ってしまい、空のプレースホルダーで静かに上書きしてしまう可能性が
あります。`timerDelay` に猶予期間を足すことで、自動提出が先に届くための猶予を与えています —
`submitToChain` は既に提出済みのプレイヤーを無視するので、自動提出が間に合った場合、`onTimer` は
単にそのプレイヤーをそのまま放っておくだけです（「未提出の分だけ埋める」という挙動は常に同じ）。

## テスト

```sh
node --test
```

すべてのテストは、時間に依存しない入力を使うか、その間 `Date.now()` を固定するかのどちらかなので、
スイート全体が完全に決定論的です — 実時計も、実時間の待ちもありません。

## ライセンス

MIT
