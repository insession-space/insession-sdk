// store / 消費者から呼ぶ、受信メッセージ以外の純粋な state 遷移（#1713）。
// いずれも (state, ...) => SpaceState の形で、reduce.ts と同じく副作用を持たない。
import { pushChatLine } from './chat-lines.ts';
import type { SpaceState } from './state.ts';

// ローカルなシステム行/チャット行の追加。use-space.ts の addChatLine 相当（key 採番 + 200行トリム）。
export function addChatLine(state: SpaceState, line: any): SpaceState {
  return pushChatLine(state, line);
}

// チャット送信(sendChat)/スタンプ送信(sendSticker)のローカルエコー(#236)。サーバーは送信者を
// 除外してブロードキャストするため、送信と同時に自分の画面へ即時反映する（往復待ちの遅延をなくす）。
// 中身は addChatLine と同じだが、呼び出し意図（受信ではなく自分の送信起因）を名前で区別する。
export function appendLocalChat(state: SpaceState, line: any): SpaceState {
  return pushChatLine(state, line);
}

// メッセージへの絵文字リアクションをトグルする(#236)。sendChatReaction 内の楽観更新(#1089)を
// そのまま移植したもの。サーバーの chat-reaction-update（全量上書き）が後着で authoritative に
// 収束するので、ここでの見た目のズレは一時的なもので構わない。
export function toggleReactionLocally(
  state: SpaceState,
  messageId: number,
  emoji: string,
  selfName: string,
): SpaceState {
  const chatLines = state.chatLines.map((line: any) => {
    if (line.id !== messageId) return line;
    const reactions = { ...(line.reactions ?? {}) };
    const cur = reactions[emoji];
    // names も楽観更新する(#1336 の「誰が押したか」表示が即時に整合するように)。
    // 後着の chat-reaction-update(全量上書き)で最終的に authoritative へ収束する。
    const curNames: string[] = cur?.names ?? [];
    if (cur?.reactedByMe) {
      if (cur.count <= 1) delete reactions[emoji];
      else
        reactions[emoji] = {
          count: cur.count - 1,
          reactedByMe: false,
          names: curNames.filter((n) => n !== selfName),
        };
    } else {
      reactions[emoji] = {
        count: (cur?.count ?? 0) + 1,
        reactedByMe: true,
        names: curNames.includes(selfName) ? curNames : [...curNames, selfName],
      };
    }
    return { ...line, reactions };
  });
  return { ...state, chatLines };
}

// 入力中表示を即時解除する(メッセージ送信時。3秒の自動クリアを待たない)。同名の呼び出し側
// タイマー(typing-timer effect)の破棄は消費者側の責務（state はここでは持たない）。
export function clearTyping(state: SpaceState, name: string): SpaceState {
  if (!state.typingUsers.includes(name)) return state;
  return { ...state, typingUsers: state.typingUsers.filter((n) => n !== name) };
}

// AI Agent 実況の取りこぼし保険タイマーが発火したときに呼ぶ（#1589）。
// ⚠ この agent の「今の実行」でなければ無視する。実行A→実行Bと続いたとき、遅れて発火した
//   Aのタイマーが B の実況を消してしまうのを防ぐ（requestId の一致を見るのが本題）。
export function expireAgentStatus(
  state: SpaceState,
  agentId: string,
  requestId: string,
): SpaceState {
  if (state.agentStatuses[agentId]?.requestId !== requestId) return state;
  const agentStatuses = { ...state.agentStatuses };
  delete agentStatuses[agentId];
  return { ...state, agentStatuses };
}

// マウント時のリセット相当。再接続前に「まだ接続確立していない」状態へ戻す。
//
// ⚠ endedAgentRuns（終了済み実行の印。#1589）もここで捨てる。旧実装ではこの印が
//   use-space.ts の素の ref で、接続 useEffect のクリーンアップ（spaceId/name の変更）ごとに
//   .clear() されていた。store へ移した際に捨て忘れると、表示名を変えて張り直したときだけ
//   印が持ち越されて挙動が変わる。connected と同じ寿命に揃えることで旧実装と一致させる（#1713）。
export function resetConnection(state: SpaceState): SpaceState {
  if (!state.connected && state.endedAgentRuns.length === 0) return state;
  return { ...state, connected: false, endedAgentRuns: [] };
}
