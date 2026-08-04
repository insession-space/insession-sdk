// サーバーが配る生のリアクション集約({emoji: {count, names}})を、自分の name で
// reactedByMe を導出した表示用の形({emoji: {count, reactedByMe, names}})に変換する(#236)。
// names は「誰が押したか」のホバー表示(#1336)に使うので落とさず持ち越す。
// use-space.ts の toReactionsView を transport 非依存の純関数として移植したもの。
// @in-session/protocol には依存しない。汎用 SDK 側の最小定義は ./types.ts 参照。
import type { ChatReactionSummary } from './types.ts';

export function toReactionsView(raw: ChatReactionSummary | undefined, selfName: string) {
  if (!raw) return {};
  const view: Record<string, { count: number; reactedByMe: boolean; names: string[] }> = {};
  for (const [emoji, data] of Object.entries(raw)) {
    view[emoji] = {
      count: data.count,
      reactedByMe: data.names.includes(selfName),
      names: data.names,
    };
  }
  return view;
}
