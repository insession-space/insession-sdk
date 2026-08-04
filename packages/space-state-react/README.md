# @insession/space-state-react

`@insession/space-state` の `SpaceStore` を React の `useSyncExternalStore` に繋ぐだけの
薄いラッパー（1関数・約10行）。

## これは何か

`@insession/space-state` はフレームワーク非依存の状態 store（React にも WebSocket にも
依存しない）。React 側で state を読んで再レンダリングを起こすための配線だけをここに切り出した
（#1720 step5）。ロジックは一切持たない。

## Install

```sh
npm install @insession/space-state-react @insession/space-state
```

ビルド済み ESM パッケージ（`dist/index.js` + `dist/index.d.ts`）として配布する。`react` は
peerDependency（`^19.0.0`）。（旧 InSession モノレポでは `.ts` ソースのまま消費されていた。）

## 使い方

```tsx
import { createSpaceStore } from '@insession/space-state';
import { useSpaceState } from '@insession/space-state-react';

const store = createSpaceStore({ selfName: 'alice', t, getPresence });

function SpaceView() {
  const state = useSpaceState(store);
  return <div>{state.members.length} 人が参加中</div>;
}
```

## API

- `useSpaceState(store: SpaceStore): SpaceState` — `store.subscribe` / `store.getState` を
  `useSyncExternalStore` にそのまま渡す。`store` 側が「state が変わらない限り `getState()` は
  同一参照を返す」契約を満たしているので、ここでの追加のメモ化は不要。
- `getServerSnapshot` は渡さない。InSession に SSR は無く、`space-state` はブラウザの
  WebSocket 接続を前提にした状態のため、サーバー側スナップショットに意味を持たせられない。

## テスト

```sh
node --test
```

## License

MIT
