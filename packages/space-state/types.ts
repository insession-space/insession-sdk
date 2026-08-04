// space-state 独立化タスク（protocol 依存を切る作業）で追加した最小型定義。
// @in-session/protocol にも同名の型がある。**こちらは汎用 SDK 側の最小定義**で、
// protocol 側が InSession のワイヤ契約の正。両者がずれても構造が同じうちは代入可能なため
// 静かに型検査を通ってしまう — そのずれは scripts/check-space-state-types.mjs（pnpm verify
// に連結）で検出する。protocol 側の該当型を変えたら、この最小定義も追随させること。
//
// ⚠ SpaceSettings はここに持ち込まない。SpaceState.settings は `Record<string, any>`
// として不透明に扱う（state.ts 参照）。設定の形は消費者ごとのワイヤ契約の一部であり、
// 汎用 store が特定アプリ（InSession）の設定型を内蔵しているのは筋が通らないため。

// チャットメッセージへの絵文字リアクションの集約。emoji→そのリアクションを付けた
// 全員の name 一覧。reactedByMe は names に自分の name が含まれるかで各クライアントが
// 導出するのでここには持たない（サーバーが配る生データ。protocol 側の同名型と同じ形）。
export type ChatReactionSummary = Record<string, { count: number; names: string[] }>;

// ピン留めされたメッセージ（同時に1件・サーバーが権威）。id だけだと chat-history 未着時に
// 表示できないため、ピン留め時点の本文をスナップショット化して保持する。
export type PinnedMessage = {
  id: number;
  name: string;
  text: string;
  // 元は protocol の ServerChatKind('text' | 'sticker' | 'agent')。汎用側では
  // 特定アプリの列挙値を持ち込まず string に緩める。
  kind?: string;
  imageUrl?: string;
  createdAt?: number;
};
