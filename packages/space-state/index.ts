// @insession/space-state の公開窓口（#1713）。
// transport/フレームワーク非依存のスペース状態 store。受信は純粋 reducer、送信は onSend に
// 流すだけ。副作用（音・通知・タイマー・送信）は effects 記述子で返し、実行は消費者が担う。
export * from './actions.ts';
export * from './effects.ts';
// 同一ユーザー(uid)のマルチデバイス入室を1人として扱うための純関数群(#1080)。
// 元は packages/space-core/presence.ts にあったが、reduce.ts が使うため #1713 で
// space-state 側の単一ソースへ移設した(space-core は再export するだけ)。
export * from './plugin.ts';
export * from './presence.ts';
export * from './reactions.ts';
export * from './reduce.ts';
export * from './state.ts';
export * from './store.ts';
// 型3つ(ChatReactionSummary/PinnedMessage)の汎用 SDK 側の最小定義(protocol 依存を切る
// 独立化タスク)。SpaceSettings は意図的に含まない(state.ts の settings コメント参照)。
export * from './types.ts';
