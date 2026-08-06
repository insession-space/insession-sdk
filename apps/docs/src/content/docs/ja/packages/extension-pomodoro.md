---
title: '@insession/extension-pomodoro'
description: 依存ゼロの、サーバーを正とするポモドーロタイマー状態機械。
---

:::note[英語版が正です]
このページは [英語版](/packages/extension-pomodoro/) を訳したものです。英語版は npm に配布される
`README.md` から自動生成されており、内容が食い違う場合は**英語版が正**です。
:::

**依存ゼロの、サーバーを正とするポモドーロタイマー状態機械。**

共有のポモドーロタイマー（「部屋のみんなが同じ時計を見ている」）は、微妙に間違えやすいものです。
カウントダウンを持つ側は、フェーズがいつ終わるかを全員と一致させ、サーバー再起動を挟んでもゴミの値から
偽のカウントダウンを再開せずに済ませ、しかも reducer をデータベースクライアントに変えてしまうことなく
「このセッションで自分が何をやるか」の宣言と互いへの声援を扱えなければなりません。

このパッケージは、その配管を全部取り除いた状態機械そのものです:

- **時計はサーバーが持ち、クライアントは刻まない。** 動作中の state は減っていくカウンターではなく
  `endsAt`（壁時計の epoch ミリ秒）を持ちます。クライアントは `endsAt` からカウントダウンを描けば
  よく、毎秒ブロードキャストする必要はありません。
- **`reduce` は純関数。** `(state, action, payload) => nextState | null`。I/O をせず、内部でタイマーを
  張ることもありません。`null` は「このアクションを無視する」という意味です（例: 停止中の `pause`）。
- **宣言と声援が組み込み。** 各メンバーは「いま何をやっているか」を一行で宣言でき、他人の宣言に対する
  声援をトグルできます。スコープも長さの上限もこちら側で面倒を見ます。
- **`restore` は設計として防御的。** ストレージ層が返してきたものを — 壊れた JSON であっても —
  そのまま渡せば、常に停止した安全な state が返ります。宣言数・声援数には上限が掛かります。
- **ランタイム依存ゼロ。** ただのオブジェクトに対する純関数の集まりです。パッケージ全体で唯一
  「純粋でない」ものは `Date.now()` で、時計を動かすアクション（`start` / `pause` / `skip`）と
  `timerDelay` / `onTimer` だけが読みます。`restore` と `persistState` は一切触らないので、保存済みの
  state の再生は完全に決定論的です。

## インストール

```sh
npm install @insession/extension-pomodoro
```

ESM（`dist/index.js`）と CommonJS（`dist/index.cjs`）の両方のエントリポイントに `dist/index.d.ts` の型を
添えたビルド済みパッケージとして配布され、ランタイム依存はありません。

:::note[0.2.0 で改名しました]
`@insession/plugin-pomodoro-state` から改名しました。旧名は npm 上で deprecated です。
API は下記の `pomodoroExtension` が増えた以外に変更はありません。
:::

## スペースに載せる

[`@insession/space`](/ja/packages/space/) でスペースを組み立てているなら、組み込みは1行です。
extension が自分の名前・reducer・タイマー・永続化の規則をまとめて持っています。

```ts
import { createSpace } from '@insession/space';
import { pomodoroExtension } from '@insession/extension-pomodoro';

const space = createSpace({ extensions: [pomodoroExtension()] });

space.dispatch('pomodoro', 'start'); // -> [broadcast, schedule-timer]
```

`{ name }` を渡せば別のキーを占有できます（独立したタイマーを2つ動かす、など）。

このオブジェクトを作るのに `@insession/space` から何も import していません。あちらの
`SpaceExtension` を**構造的に**満たしているだけなので、このパッケージは依存ゼロのままで、
以下の使い方も `@insession/space` 無しでそのまま通用します。

## 使い方

```ts
import {
  defaultState,
  onTimer,
  persistState,
  reduce,
  restore,
  timerDelay,
  type PomodoroState,
} from '@insession/extension-pomodoro';

// ルームごとに PomodoroState を1つ持つ場所。例えば Map<roomId, PomodoroState>。
let state: PomodoroState = defaultState();

// クライアントのアクションが transport（WebSocket 等）経由で届く。`by` は操作したメンバーを
// 指し、それをどう導くか（セッション・認証…）はあなたの判断。
function onClientAction(action: string, payload: unknown) {
  const next = reduce(state, action, payload as Record<string, unknown>);
  if (!next) return; // 無効、または no-op — 何も変わっていないので配信するものも無い
  state = next;
  broadcastToRoom({ type: 'extension-pomodoro', state });
  schedulePhaseTimer();
}

// フェーズ遷移は自分のタイマー（setTimeout、ジョブキュー…）で駆動する。
let phaseTimer: ReturnType<typeof setTimeout> | undefined;
function schedulePhaseTimer() {
  clearTimeout(phaseTimer);
  const delay = timerDelay(state);
  if (delay === null) return; // 動作中でない — 張るものは無い
  phaseTimer = setTimeout(() => {
    state = onTimer(state);
    broadcastToRoom({ type: 'extension-pomodoro', state });
    schedulePhaseTimer();
  }, delay);
}

// ルーム起動時・最初の入室時にストレージから読む。
function loadFromDb(raw: unknown) {
  state = restore(raw) ?? defaultState();
}

// ストレージへ書く前に、セッション限りの participants を落とす。
function saveToDb() {
  db.write(persistState(state));
}
```

### アクション

`reduce(state, action, payload)` は次の `action` 文字列を受け付けます:

| アクション | ペイロード | 効果 |
| --- | --- | --- |
| `start` | — | `remaining` からタイマーを開始する。既に動作中なら no-op（`null`）。 |
| `pause` | — | タイマーを止め、`remaining` を凍結する。既に停止中なら no-op。 |
| `reset` | — | フェーズ・サイクル・タイマーを初期化する。ただし `config`・`declarations`・`participants` は**保持する**。 |
| `skip` | — | 完了サイクルとして数えずに、次のフェーズへ即座に進める。 |
| `configure` | `{ workMinutes?, breakMinutes? }` | フェーズの長さを設定する（1〜120分にクランプ）。停止中のみ。数値に変換できる値（`null`・`''`・`false`・`[]` はいずれも `0` に変換される）は現在の config へフォールバックせず1分にクランプされる。有限の数値に変換できない値（例: `'nope'`・`undefined`）だけがフォールバックする。 |
| `declare` | `{ by, text?, uid? }` | `by` の一行宣言を設定する（`text` が空なら解除）。 |
| `cheer` | `{ target, by }` | `target` の宣言に対する `by` の声援をトグルする。自分への声援や、未宣言の相手への声援は no-op。 |
| `join` | `{ by, uid? }` | `by` をこのセッションの参加者として記録する。 |
| `leave` | `{ by }` | `by` をセッションの参加者から外す。 |

これ以外の `action` 文字列はすべて `null` を返します。ペイロードはワイヤ越しに届くため、あらゆる
フィールドは信用できないものとして使う直前に検証されます — `reduce` は不正な入力で例外を投げず、
代わりに `null` を返します。

## API

| エクスポート | シグネチャ | 意味 |
| --- | --- | --- |
| `defaultState()` | `() => PomodoroState` | 宣言も参加者も無い、停止状態の 25分/5分 の新しい state。 |
| `reduce` | `(state, action, payload?) => PomodoroState \| null` | アクションを1つ適用する。`null` は「無視する」（無効または no-op）。 |
| `timerDelay` | `(state) => number \| null` | 現在のフェーズが終わるまでのミリ秒。動作中でなければ `null`。 |
| `onTimer` | `(state) => PomodoroState` | `timerDelay` が経過したときに呼ぶ。フェーズを進め、動作を継続する。 |
| `restore` | `(raw: unknown) => PomodoroState \| null` | ストレージから読んだ state を正規化する。`null` になるのはオブジェクトでない入力のときだけで、それ以外は常に停止状態で上限が適用される。 |
| `persistState` | `(state) => PomodoroState` | ストレージへ書く前に `participants` を落とす（セッション限りのため）。 |

### 型

`PomodoroState`・`PomodoroPhase`・`PomodoroConfig`・`PomodoroDeclaration`・`PomodoroParticipant`・
`PomodoroAction`・`PomodoroPayload` はすべてエクスポートされています。`reduce` の `action` 引数が
`PomodoroAction` ではなく `string` なのは意図的です — ここはアクション名が信用できない入力として
届くワイヤ境界であり、既知の集合から外れたものはすべて `null` に落ちます。

### なぜ `participants` を永続化しないのか

`state.participants` が答えるのは「いまこのセッションに誰がいるか」で、これは人が実際に接続している
間だけ意味を持つ signal です。`restore` は常に空で返し、`persistState` は書き込み前に落とすので、
古くなった在室リストが再起動を生き延びたり、読まれないままストレージに残り続けたりしません。

### なぜ `declarations` は `reset` / `skip` を生き延びるのか

宣言は「このセッションで自分が何をやるか」であって、フェーズごとの state ではありません。`reset` は
タイマーを初期化するのであって、意図をリセットするわけではないからです。`restore` が保持するのは
`uid` を持つ宣言だけで、ゲストの宣言は `reduce` に渡すメモリ上の state にしか存在せず、リロード時に
意図的に捨てられます。

## テスト

```sh
node --test
```

すべてのテストは、時間に依存しない入力を使うか、その間 `Date.now()` を固定するかのどちらかなので、
スイート全体が完全に決定論的です — 実時計も、実時間の待ちもありません。

## ライセンス

MIT
