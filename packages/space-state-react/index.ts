// @insession/space-state-react の公開窓口（#1720 step5）。
// @insession/space-state の SpaceStore を React に繋ぐだけの薄いラッパー。

import type { SpaceState, SpaceStore } from '@insession/space-state';
import { useSyncExternalStore } from 'react';

// store を React に繋ぐだけの薄い層。store 側が useSyncExternalStore の契約
// (state 不変なら getState が同一参照を返す)を満たしているので、ここは購読の配線だけを担う。
// getServerSnapshot は渡さない: InSession に SSR は無く（Vite SPA。#80 参照）、
// space-state はブラウザの WebSocket 接続を前提にした状態なのでサーバー側スナップショットに
// 意味を持たせられないため。
export function useSpaceState(store: SpaceStore): SpaceState {
  return useSyncExternalStore(store.subscribe, store.getState);
}
