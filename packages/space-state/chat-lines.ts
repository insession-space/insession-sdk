// チャット行の追加（key 採番 + トリム）。reduce.ts（受信によるログ/チャット追加）と
// actions.ts（ローカルエコー等）の双方から使う共通ヘルパー（addChatLine の移植・#1713）。
import type { SpaceState } from './state.ts';
import { CHAT_LINES_MAX } from './state.ts';

export function pushChatLine(state: SpaceState, line: any): SpaceState {
  const nextChatKey = state.nextChatKey + 1;
  const chatLines = [
    ...state.chatLines.slice(-(CHAT_LINES_MAX - 1)),
    { ...line, key: nextChatKey },
  ];
  return { ...state, chatLines, nextChatKey };
}
