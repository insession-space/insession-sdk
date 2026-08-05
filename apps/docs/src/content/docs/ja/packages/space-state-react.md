---
title: '@insession/space-state-react'
description: '@insession/space-state の React バインディング。フック1つ・約10行で、ロジックは持たない。'
---

:::note[英語版が正です]
このページは [英語版](/packages/space-state-react/) を訳したものです。英語版は npm に配布される
`README.md` から自動生成されており、内容が食い違う場合は**英語版が正**です。
:::

[`@insession/space-state`](https://www.npmjs.com/package/@insession/space-state) の React
バインディング — フック1つ、約10行、独自のロジックは持ちません。

`@insession/space-state` は意図的にフレームワーク非依存です（React にも WebSocket 実装にも依存
しません）。その `getState` / `subscribe` の組は既に `useSyncExternalStore` の契約を満たしている
ので（何も変わっていない限り `getState()` は同一参照を返す）、残っているのは配線だけです。
その配線がこのパッケージで、**store 自身を React 依存から自由なままにするため**に分けてあります。

## インストール

```sh
npm install @insession/space-state-react @insession/space-state
```

ビルド済み ESM パッケージ（`dist/index.js` + `dist/index.d.ts`）として配布されます。`react` は
peer dependency（`^19.0.0`）です。`@insession/space-state` は直接の依存ですが、どのみち自分でも
import することになります。

## 使い方

```tsx
import { createSpaceStore } from '@insession/space-state';
import { useSpaceState } from '@insession/space-state-react';

const store = createSpaceStore({
  selfName: 'alice',
  t: (key) => key,
  getPresence: () => 'active',
});

function SpaceView() {
  const state = useSpaceState(store);

  return (
    <>
      <p>{state.members.length} 人が参加中</p>
      <ul>
        {state.chatLines.map((line) => (
          <li key={line.key}>{line.text}</li>
        ))}
      </ul>
      <button type="button" onClick={() => store.chat.send('hello')}>
        あいさつする
      </button>
    </>
  );
}
```

state を読むのはフック経由、送るのは store のローカルアクション（`store.chat.send`、
`store.presence.change` …）へ直接です。**provider も context もありません** — store は普段どおりの
方法で受け渡してください。

## API

| エクスポート | 意味 |
| --- | --- |
| `useSpaceState(store: SpaceStore): SpaceState` | store を購読し、変更時に再レンダリングする。`store.subscribe` と `store.getState` をそのまま `useSyncExternalStore` へ渡す。 |

知っておくとよいことが2つあります:

- **追加のメモ化は不要です。** store は「state が変わらない限り同一参照」を保証しており、これは
  `useSyncExternalStore` が再レンダリングを省くために求めるものそのものです。
- **`getServerSnapshot` は渡していません。** store は生きた接続をモデル化しているため、返すべき
  意味のあるサーバー側スナップショットが存在しないからです。**このフックを呼ぶコンポーネントを
  SSR でレンダリングすると例外になります** — クライアント側に留めてください。

## テスト

```sh
node --test
```

## ライセンス

MIT
