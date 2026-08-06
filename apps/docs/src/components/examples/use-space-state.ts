// store を React に繋ぐフック。**SDK はこれを出荷しない** — `SpaceStore` は
// `useSyncExternalStore` の契約（state が変わらない限り getState が同一参照を返す）を
// そのまま満たしているので、消費者がこの1行を自分のコードベースに置けば足りる。
//
// かつては @insession/space-state-react として別パッケージで配っていたが、本体が1行しかなく
// 自前の変更が一度も無いまま space-state の採番に引きずられるだけだったので廃止した（#42）。
// このデモ群は「消費側が書くコード」の実例そのものなので、ここに置いている。

import type { SpaceState, SpaceStore } from '@insession/space-state';
import { useSyncExternalStore } from 'react';

// getServerSnapshot は渡さない: このサイトのデモは client:only で動く純クライアントで、
// space-state はブラウザの WebSocket 接続を前提にした状態なのでサーバー側スナップショットに
// 意味を持たせられないため。SSR する消費者は自分の初期状態を第3引数で渡すことになる。
export function useSpaceState(store: SpaceStore): SpaceState {
  return useSyncExternalStore(store.subscribe, store.getState);
}
