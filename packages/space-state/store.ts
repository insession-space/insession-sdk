// transport/React 非依存のスペース状態ストア（#1713）。受信は reduceSpace（純粋 reducer）に
// 委ね、getState/subscribe は useSyncExternalStore にそのまま渡せる契約にしてある。
// 副作用（音・通知・タイマー）の実行はしない。effects は onEffect の購読者へそのまま配るだけ。
import {
  addChatLine,
  appendLocalChat,
  clearTyping,
  expireAgentStatus,
  resetConnection,
  toggleReactionLocally,
} from './actions.ts';
import type { SpaceEffect } from './effects.ts';
import type { PluginClient } from './plugin.ts';
import { type ReduceCtx, reduceSpace } from './reduce.ts';
import { initialSpaceState, type SpaceState } from './state.ts';

// チャット送信のローカルエコー行とサーバー採番idを対応付けるための一時ID(#236)。
// crypto.randomUUID が使えない環境(非secure context等)向けにフォールバックする。
// use-space.ts の genClientMsgId と同じ実装。
function defaultGenClientMsgId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export type SpaceStoreOptions = {
  selfName: string;
  // 純粋な文言解決関数。消費者が注入する（i18n の t をそのまま渡せる）。
  t: (key: string, ...args: any[]) => string;
  getPresence: () => 'active' | 'away';
  // 既定 Date.now。テストや決定論的な再生のために差し替え可能にしてある。
  now?: () => number;
  genClientMsgId?: () => string;
  // スペースアプリ(plugin)の記述子一覧(#1720 step6)。省略時は空配列
  // (core は自分ではアプリ固有ロジックを一切持たない)。
  plugins?: PluginClient[];
  // settings の初期値/既定値（省略時 {}）。space-state は特定アプリの設定既定値を
  // 知らないため、消費者(useSpace)が自分のワイヤ契約の既定値(例: protocol の
  // defaultSettings())をここで注入する。initialSpaceState の初期表示にも、
  // reduce.ts が 'msg.settings が無いとき' のフォールバックにも同じ値を使う
  // (ReduceCtx.defaultSettings。protocol 依存を切る独立化タスク)。
  initialSettings?: Record<string, any>;
};

export type SpaceStore = ReturnType<typeof createSpaceStore>;

export function createSpaceStore(opts: SpaceStoreOptions) {
  const initialSettings = opts.initialSettings ?? {};
  let state = initialSpaceState(initialSettings);
  // selfName / t は言語変更等であとから差し替えられる(use-space.ts の tRef と同じ理由。
  // 現行の t は言語変更で差し替わっても再接続しないため)。opts をそのまま持たず、
  // setSelfName/setT で更新できるミュータブルな変数として保持する。
  let selfName = opts.selfName;
  let t = opts.t;
  const getPresence = opts.getPresence;
  const now = opts.now ?? Date.now;
  const genClientMsgId = opts.genClientMsgId ?? defaultGenClientMsgId;
  const plugins = opts.plugins ?? [];

  const listeners = new Set<() => void>();
  const sendHandlers = new Set<(msg: any) => void>();
  const effectHandlers = new Set<(e: SpaceEffect) => void>();

  // 入力中通知の送信スロットル(1秒。use-space.ts の lastTypingSentRef と同じ)。
  let lastTypingSentAt = 0;

  function getState(): SpaceState {
    return state;
  }

  // useSyncExternalStore 契約: state が変わらない限り同一参照を返す。
  function setState(next: SpaceState) {
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  }

  function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function onSend(fn: (msg: any) => void) {
    sendHandlers.add(fn);
    return () => sendHandlers.delete(fn);
  }

  function onEffect(fn: (e: SpaceEffect) => void) {
    effectHandlers.add(fn);
    return () => effectHandlers.delete(fn);
  }

  // 生の送信。onSend の購読者(transport)へそのまま流すだけ。
  function send(msg: any) {
    for (const fn of sendHandlers) fn(msg);
  }

  // 受信メッセージを reduceSpace へ通し、state を更新して effects を配る。
  function receive(msg: any) {
    const ctx: ReduceCtx = {
      selfName,
      t,
      now: now(),
      presence: getPresence(),
      plugins,
      defaultSettings: initialSettings,
    };
    const { state: next, effects } = reduceSpace(state, msg, ctx);
    setState(next);
    for (const effect of effects) {
      for (const fn of effectHandlers) fn(effect);
    }
  }

  return {
    getState,
    subscribe,
    receive,
    onSend,
    onEffect,
    send,

    // チャット送信: サーバーは送信者を除外してブロードキャストするので、
    // 自分の画面には即座にローカル表示する(往復待ちの遅延をなくす)。
    // clientMsgId を添えて送り、サーバーから返る chat-ack で自分の行にも永続id(リアクションの
    // 紐付け先)を反映する(#236)。ack到着までは id:null のためリアクションUIは出さない。
    // replyTo(#324): 返信対象メッセージのスナップショット({id,name,text})。返信でなければ省略。
    chat: {
      send(text: string, replyTo?: { id: number; name: string; text: string }) {
        const clientMsgId = genClientMsgId();
        send({ type: 'chat', text, clientMsgId, replyToId: replyTo?.id ?? null });
        // ローカルエコーには avatar を載せない(#1246)。自分は必ず在室しているので
        // 消費者側の members 逆引きで解決できる。space-state はアプリ側の
        // auth 依存(自分の avatar 値)を持ち込まないための意図的な非対称。
        setState(
          appendLocalChat(state, {
            kind: 'chat',
            name: selfName,
            self: true,
            text,
            id: null,
            clientMsgId,
            reactions: {},
            replyTo: replyTo ?? undefined,
            createdAt: now(),
          }),
        );
      },

      // 画像スタンプメッセージの送信(#394)。imageUrl は呼び出し側が事前に
      // POST /api/spaces/:id/stickers へアップロード済みの公開URL。send と同じく
      // サーバーは送信者を除外してブロードキャストするのでローカルエコーする(id:nullでchat-ackを待つ)。
      sendSticker(imageUrl: string) {
        const clientMsgId = genClientMsgId();
        send({ type: 'chat', text: '', clientMsgId, kind: 'sticker', imageUrl });
        setState(
          appendLocalChat(state, {
            kind: 'chat',
            name: selfName,
            self: true,
            text: '',
            id: null,
            clientMsgId,
            reactions: {},
            imageUrl,
            createdAt: now(),
          }),
        );
      },

      // メッセージへの絵文字リアクションをトグルする(#236)。id が無いメッセージ(ack未着・DB未設定)
      // には送らない。送信と同時にローカルでもトグル反映する(#1089 楽観的更新)。
      react(messageId: number | null, emoji: string) {
        if (!messageId) return;
        send({ type: 'chat-reaction', messageId, emoji });
        setState(toggleReactionLocally(state, messageId, emoji, selfName));
      },

      // メッセージのピン留め/解除(#1052)。messageId===null で解除。サーバーが全員へ配信し、
      // 同時に1件だけという不変条件もサーバー側が保持する(クライアントは表示とアクションのみ)。
      pin(messageId: number | null) {
        send({ type: 'pin-message', messageId });
      },

      // 入力中通知の送信: 呼び出し側は入力のたびに呼んでよい。ここで1秒以内の連打を間引く
      // (サーバー・帯域への配慮。自分自身には何も表示しない)。
      typing() {
        const t0 = now();
        if (t0 - lastTypingSentAt < 1000) return;
        lastTypingSentAt = t0;
        send({ type: 'typing' });
      },
    },

    settings: {
      update(patch: any) {
        send({ type: 'update-space-settings', settings: patch });
      },
    },

    presence: {
      change(p: 'active' | 'away') {
        send({ type: 'presence-change', presence: p });
      },
    },

    // 🧩スイッチャーでの表示中カード切替をサーバーへ通知する。stage は 'player' | plugin の
    // appId | null(未選択)。サーバーは送信者含む全員へ member-updated で配信する
    stage: {
      change(stage: string | null) {
        send({ type: 'stage-change', stage });
      },
    },

    // ローカルなシステム行の追加(現行 useSpace の公開 addChatLine と同義)。
    addChatLine(line: any) {
      setState(addChatLine(state, line));
    },

    // 名前ごとの自動クリアタイマー(3秒)の発火時に消費者から呼ぶ。
    clearTyping(name: string) {
      setState(clearTyping(state, name));
    },

    // AI Agent 実況の取りこぼし保険タイマーの発火時に消費者から呼ぶ。
    expireAgentStatus(agentId: string, requestId: string) {
      setState(expireAgentStatus(state, agentId, requestId));
    },

    reset() {
      setState(resetConnection(state));
    },

    // t は言語変更で差し替わっても再接続しない(use-space.ts の tRef と同じ理由)。
    setT(next: (key: string, ...args: any[]) => string) {
      t = next;
    },
    setSelfName(next: string) {
      selfName = next;
    },
  };
}
