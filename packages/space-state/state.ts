// スペース同期の core 状態（#1713）。use-space.ts の useState 群を1つの state 木へ集約したもの。
// transport にも React にも依存しない純粋な型なので、useSyncExternalStore にも
// 別の UI 層にも同じ形で載せられる。

// ⚠ @in-session/protocol には依存しない（space-state を transport/フレームワークだけでなく
// InSession 固有のワイヤ契約からも切り離すための独立化タスク）。PinnedMessage は
// ./types.ts に汎用 SDK 側の最小定義を持つ。SpaceSettings は持ち込まず、settings は
// Record<string, any> として不透明に扱う（下記コメント参照）。
import type { PinnedMessage } from './types.ts';

// AI Agent の実況表示をクライアント側で強制終了するまでの時間（#1589）。
// ⚠ サーバーの実行締め切り（runtime.ts の RUN_TIMEOUT_MS = 20秒）**より必ず長く**すること。
//   短くすると、正常に走っている実行の実況を先に消してしまう。ここはあくまで
//   「サーバーの idle が届かなかったとき」の最後の保険で、通常は発火しない。
export const AGENT_STATUS_TIMEOUT_MS = 40_000;

// 「終了済み」として覚えておく実行の数（#1589）。遅れて届いたフレームを弾くためだけの印なので、
// 直近ぶんが残っていれば足りる。無制限に貯めると長時間の在室でメモリが増え続ける。
export const AGENT_ENDED_RUNS_MAX = 32;

// チャット行の保持上限。addChatLine は常に直近 200 行にトリムする（use-space.ts と同じ）。
export const CHAT_LINES_MAX = 200;

export type SpaceState = {
  // 初回 space-state を受信済みか（＝WS 接続確立の実質的な指標。#118）。UI の初回ローディング表示に使う。
  connected: boolean;
  // 自分のクライアントid（space-state の selfId）。Video Chat（#29）のグレア回避
  // （自分より小さいidの側がofferを送る決定論ルール）等、id比較が要る plugin 向けに公開する。
  selfId: number | null;
  members: any[];
  title: any;
  // 現在ピン留め中のメッセージ(#1052)。同時に1件のみ・サーバーが権威。無ければ null
  pinnedMessage: PinnedMessage | null;
  owner: any;
  // スペースの種別(#1419)。'my_space' はアカウントごとに1つ持つ常設スペース、'ephemeral' は
  // 通常の使い捨てスペース。⚠ 既定は 'ephemeral'。owner の有無で代用してはいけない — 通常の
  // スペースでも作成者がログイン中なら owner は立つので、owner を種別の判定に使うと
  // 全スペースがマイスペース扱いになる。
  kind: 'ephemeral' | 'my_space';
  // 紐づくコミュニティ(あれば)。トップバーのバッジ表示専用(#841)。owner と同じ流れ。
  community: any;
  // ⚠ 意図的に不透明（Record<string, any>）。store は settings の中身を一切読まず丸ごと
  // 保持・置換するだけなので、InSession の SpaceSettings 型（YouTube 固有の設定まで含む
  // 合成型）を汎用 store 側に持ち込む理由が無い。設定の形は消費者ごとのワイヤ契約の一部
  // であり、消費者が自分の型へキャストして使う（既定値も createSpaceStore の
  // initialSettings で消費者が注入する。下記 initialSpaceState 参照）。
  settings: Record<string, any>;
  // このスペースが紐づく community(#845)。設定の「公開範囲」で 'community' を選べるかの判定に使う。
  communityId: any;
  // サーバー側の機能可用性フラグ(尺上限はYOUTUBE_API_KEY設定時のみ)
  features: { durationLimit: boolean };
  // スペースアプリの状態 { [appId]: state }
  apps: Record<string, any>;
  // relay専用メッセージ(app-relay)で届く高頻度データを送信者別に保持 { [appId]: { [by]: payload } }。
  // app-state と違いサーバーは保存しない(揮発)。ホワイトボードの描画リレーに使う
  appRelay: Record<string, Record<string, any>>;
  // AI Agent の実行状態(#1589)。{ [agentId]: { requestId, phase, tool } }。
  // ⚠ app-relay と同じく**揮発**。space-state にも chat-history にも無いので、途中入室や
  //   リロード直後は必ず空から始まる(サーバーが復元して配ることはしない)。
  agentStatuses: Record<
    string,
    { requestId: string; phase: 'thinking' | 'working'; tool?: string }
  >;
  chatLines: any[];
  // 入力中インジケーター: 現在入力中のメンバー名一覧(揮発。DB保存なし・space-state 復元対象外)
  typingUsers: string[];
  // ── 以下は現行 use-space.ts では useRef で持たれている「遷移検知用の直前値」。reducer が
  //    前状態を引数で受け取れる以上 ref は不要になるので state へ引き上げた（純粋性のため）。
  // 画面共有(#180)の直前の共有者。なし→ありへの遷移検知にだけ使う(表示状態そのものは
  // 消費者が独自に screen-share-state を購読して持つ。ここは「開始ログを出すか」の判定専用)
  screenShareSharer: { id: number; name: string } | null;
  // plugin(スペースアプリ)ごとのローカルスライス { [appId]: any }(#1720 step6)。
  // 「直前のポモドーロ phase」のような plugin 固有の遷移検知用の値は、ここに plugin 自身が
  // 持つ(core はキー=appId しか知らず、値の中身には一切踏み込まない)。plugin.ts の
  // PluginClient.initLocal/onAppState が読み書きする。
  pluginLocal: Record<string, any>;
  // 終了済みの requestId（#1589）。**idle のあとに同じ実行の 'working' が届いても無視する**ための印。
  // サーバー側でも置き去りの道具呼び出しは止めている（runtime.ts の RunState）が、フレームの
  // 並べ替えはネットワーク側でも起きうるので受け側にも同じ判定を置く。FIFO・上限 AGENT_ENDED_RUNS_MAX。
  endedAgentRuns: string[];
  // 現行 keyRef の採番カウンタ。チャット行の React key に使う（addChatLine のたびに +1）。
  nextChatKey: number;
};

// initialSettings: 消費者が注入する settings の既定値（省略時 {}）。汎用 store は
// InSession の既定値(defaultSettings())を知らないため、呼び出し側(createSpaceStore の
// options 経由)が渡す。
export function initialSpaceState(initialSettings: Record<string, any> = {}): SpaceState {
  return {
    connected: false,
    selfId: null,
    members: [],
    title: null,
    pinnedMessage: null,
    owner: null,
    kind: 'ephemeral',
    community: null,
    settings: initialSettings,
    communityId: null,
    features: { durationLimit: false },
    apps: {},
    appRelay: {},
    agentStatuses: {},
    chatLines: [],
    typingUsers: [],
    screenShareSharer: null,
    pluginLocal: {},
    endedAgentRuns: [],
    nextChatKey: 0,
  };
}
