// reduceSpace が state 更新と同時に返す副作用の記述子（#1713）。
// reducer 自身は純粋関数のまま保つため、音を鳴らす・OS通知を出す・タイマーを張るといった
// 実際の副作用実行は一切ここでは行わない。消費者（useSpace 等）が effect を解釈して実行する。

export type SpaceEffect =
  // core が知る音は join/chat の2種のみ。plugin 固有の音は下記 plugin-sound で流す
  // (#1720 step6。core が個々の plugin 名や音色を知らずに済むようにするため)。
  | { type: 'sound'; sound: 'join' | 'chat' }
  // 入室通知。本文組み立て（多言語文言の解決）は消費者側で行う（reducer は t を選べる場面と
  // 選べない場面が混ざるため、文面が固定できるものだけ text 済みで渡す方針。下記参照）。
  | { type: 'notify-join'; name: string }
  // チャット通知。メンション判定（isMentioningSelf）は消費者(mention.ts)が行う。
  | { type: 'notify-chat'; name: string; text: string }
  // plugin(スペースアプリ)固有の効果音・通知チャンネル(#1720 step6)。appId で発生源を識別し、
  // 実際にどの音を鳴らす/どう通知するかへのマッピングは消費者(useSpace の deps)側が行う。
  // core の effect(join/chat)と分けるのは、core が plugin 固有の音色や通知文言を知らずに
  // 済むようにするため(#1720 step6 で plugin 固有ロジックを剥がした際にこの分離を作った。
  // reduce.ts 参照)。
  | { type: 'plugin-sound'; appId: string; sound: string }
  | { type: 'plugin-notify'; appId: string; text: string }
  // updateHistoryTitle 相当（ローカル訪問履歴のタイトル更新）。
  | { type: 'history-title'; title: unknown }
  // presence 再申告など reducer 起因の送信（space-state 受信時に away を送り直す等）。
  | { type: 'send'; message: any }
  // 入力中表示を3秒後に自動クリアする（typingName ごとに1本、張り直しは消費者が担う）。
  | { type: 'typing-timer'; name: string }
  // 入力中表示を即時解除した(chat 受信)ときに、対応する自動クリアタイマー(上記 typing-timer)
  // を解除する。表示の除去(typingUsers から name を消す)だけでなく、残っている3秒タイマー
  // 自体も止めないと、消費者側に不要なタイマーが残ってしまう(#1713)。
  | { type: 'typing-timer-clear'; name: string }
  // AI Agent 実況の取りこぼし保険。AGENT_STATUS_TIMEOUT_MS 後に expireAgentStatus(agentId, requestId) 相当を実行する。
  | { type: 'agent-timer'; agentId: string; requestId: string }
  // 対応する idle 受信時などにタイマーを解除する。
  | { type: 'agent-timer-clear'; requestId: string };
