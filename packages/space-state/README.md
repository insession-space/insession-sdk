# @insession/space-state

transport/フレームワーク非依存の**スペース状態 store**。サーバーから届く生のメッセージを
純粋 reducer で畳み込み、副作用（音・通知・タイマー・送信）は実行せず記述子として返すだけの
薄い状態管理層。

## これは何か

InSession の `useSpace`（`@in-session/space-core`）が持っていた「受信メッセージの畳み込み」
「チャット等のローカルアクション」「ローカル state 管理」を、React にも WebSocket 実装にも
依存しない形で切り出したパッケージ（#1713）。

- **サーバーは要らない**。`receive()` にメッセージオブジェクトを渡すだけで動く（テストは
  `node --test` でサーバー・ブラウザ・WebSocket 一切なしに完結する）。
- **永続化は要らない**。state はプロセス内メモリのみ。DB や localStorage には触れない。
- **依存ゼロ**。React・WebSocket・DOM はもちろん、`@in-session/protocol` にも依存しない。
  - スペース設定（`settings`）の**中身はこの store が一切解釈しない**（丸ごと保持して置き換えるだけ）。したがって設定の型も既定値もここには持たず、既定値は `createSpaceStore({ initialSettings })` で**消費者が注入する**。「サーバーも永続化も要らない」のと同じ考え方で、設定の形は消費者のワイヤ契約の一部だという整理（#1713）。
  - `ChatReactionSummary` / `PinnedMessage` は `./types.ts` に**汎用側の最小定義**として持つ。InSession のワイヤ契約としての正は `@in-session/protocol` 側で、**型が2箇所に分かれている**。ずれは `pnpm check:space-state-types` が機械的に突き合わせて検出する（任意フィールドの欠落・型の狭め・必須化・余計なフィールドの4通りで実際に落ちることを確認済み）。

## Install

```sh
npm install @insession/space-state
```

ビルド済み ESM パッケージ（`dist/index.js` + `dist/index.d.ts`）として配布する。ランタイム
依存はゼロ。（旧 InSession モノレポでは `.ts` ソースのまま消費されていた。）

## 使い方

```ts
import { createSpaceStore } from '@insession/space-state';

const store = createSpaceStore({
  selfName: 'alice',
  t: (key) => key, // i18n の t をそのまま渡せる。テストなら恒等関数でよい
  getPresence: () => 'active',
});

// 送信を transport に配線する（実際の WebSocket 送信は呼び出し側の責務）
store.onSend((msg) => ws.send(JSON.stringify(msg)));

// 副作用（音・通知・タイマー等）の実行も呼び出し側の責務。store 自身は実行しない
store.onEffect((effect) => {
  if (effect.kind === 'play-chat-sound') playChat();
});

// 受信メッセージを渡すと reduceSpace が畳み込み、購読者へ通知する
store.receive({ type: 'chat', name: 'bob', text: 'hi' });

// state を読む / 変更を購読する（useSyncExternalStore の契約: 不変なら同一参照を返す）
store.getState();
store.subscribe(() => console.log('changed'));

// ローカルアクション（サーバーへの送信 + 楽観的ローカル反映）
store.chat.send('hello');
store.settings.update({ watchParty: { enabled: false } });
```

## API

- `createSpaceStore(opts): SpaceStore` — store を生成する。`opts` は `selfName` / `t` /
  `getPresence` / 任意の `now` / `genClientMsgId`（テストで決定論的にしたいときに差し替える）。
- `store.receive(msg)` — サーバーからの生メッセージを渡す。内部で `reduceSpace`（純粋 reducer）
  を通し、state を更新して effects を `onEffect` の購読者へ配る。
- `store.getState()` / `store.subscribe(listener)` — `useSyncExternalStore` にそのまま渡せる
  契約（state が変わらない限り `getState()` は同一参照を返す）。React へ繋ぐ薄いラッパーは
  `@insession/space-state-react` の `useSpaceState` を使う。
- `store.onSend(fn)` / `store.send(msg)` — ローカルアクション（`chat.send` 等）が生成した送信
  メッセージを配る。実際の WebSocket 送信は購読者（transport）の責務。
- `store.onEffect(fn)` — 副作用記述子（音・通知・タイマー等）を配る。実行は購読者の責務。
- `store.chat` / `store.settings` / `store.presence` / `store.stage` — ローカルアクション群
  （送信 + 必要なら楽観的ローカル反映）。

## テスト

```sh
node --test
```

`reduce.test.ts` が純粋 reducer の入出力を assert で検証する（実サーバー・実ブラウザ不要）。

## License

MIT
