// スペース統合デモの「サーバー役」。React に一切依存しない素の TypeScript。
//
// ⚠ 挙動を再実装しないこと。ここがやるのは4つのパッケージを **呼ぶ** ことだけで、
// 状態遷移そのものは一行も書かない。判断は全て reduce の中にある。
//
// InSession の本物のサーバーがやっていることを、そのままの順序で並べてある:
//   1. クライアントから届いたワイヤメッセージを、対応する状態機械の action へ振り分ける
//   2. reduce を呼ぶ（null が返ったら黙って捨てる — 不正・no-op はここで止まる）
//   3. 返ってきた effect 記述子を実行する（採番・保存・タイトル解決）
//   4. 配信先を決めて配る（全員 / 送信者を除く全員 / 送信者だけ）
//
// パッケージ側は 1・3・4 を一切しない。だからこのファイルが要る、というのがこのデモの主題。

import {
  type ChatEffect,
  type ChatPayload,
  type ChatState,
  createChatState,
} from '@insession/extension-chat';
import {
  type PomodoroState,
  defaultState as pomodoroDefaultState,
  onTimer as pomodoroOnTimer,
  reduce as pomodoroReduce,
  timerDelay as pomodoroTimerDelay,
} from '@insession/extension-pomodoro';
import {
  createWatchParty,
  type WatchPartyEffect,
  type WatchPartyState,
} from '@insession/extension-watch-party';
import { createWhiteboardState, type WhiteboardState } from '@insession/extension-whiteboard';

/** スペースに居る2人。実サーバーなら認証済みの接続から来る値。 */
export const MEMBERS = [
  { id: 1, name: 'Alice', uid: 'u-alice' },
  { id: 2, name: 'Bob', uid: 'u-bob' },
] as const;

export type MemberName = (typeof MEMBERS)[number]['name'];

/** このデモの host だけが知っているストレージ。パッケージからは見えない。 */
export const OWN_UPLOAD_PREFIX = 'https://cdn.example.com/uploads/';
export const OWN_STICKER = `${OWN_UPLOAD_PREFIX}wave.png`;

/** 11文字の英数字/ハイフン/アンダースコアでないと watch-party の VIDEO_ID_RE に弾かれる。 */
export const VIDEOS = [
  { id: 'dQw4w9WgXcQ', label: 'Video A' },
  { id: 'jNQXAC9IVRw', label: 'Video B' },
] as const;

/** 在室メンバー1人。`currentStage` は 🧩スイッチャーで今どのカードを見ているか。 */
export type DemoMember = {
  id: number;
  name: string;
  uid: string;
  currentStage: string | null;
  presence: 'active' | 'away';
};

/**
 * ホストが決めた1件の配信。`exclude` は broadcast(excludeSender)、`only` は send-to-sender。
 * どちらも無ければ全員宛。
 */
export type Delivery = { message: any; exclude?: string; only?: string };

/** トレース1行ぶん（Trace.tsx の TraceEntry から id を除いたもの）。 */
export type HostStep = { call: string; ret?: string; effects?: string[]; noop?: boolean };

export type HostOutcome = { deliveries: Delivery[]; steps: HostStep[] };

const EMPTY: HostOutcome = { deliveries: [], steps: [] };

function chatEffectLabel(e: ChatEffect): string {
  switch (e.type) {
    case 'persist-chat':
      return `persist-chat → { kind: '${e.draft.kind}', text: ${JSON.stringify(e.draft.text)} } — host が採番する`;
    case 'broadcast':
      return `broadcast${e.excludeSender ? ' (excludeSender)' : ''} → { type: '${(e.message as { type?: string })?.type}' }`;
    case 'send-to-sender':
      return `send-to-sender → { type: '${(e.message as { type?: string })?.type}' }`;
    case 'toggle-reaction':
      return `toggle-reaction → { messageId: ${e.messageId}, emoji: '${e.emoji}' }`;
    case 'resolve-message':
      return `resolve-message → { messageId: ${e.messageId} } — host が引き直す`;
    case 'persist-pinned':
      return `persist-pinned → ${e.pinned ? `{ id: ${e.pinned.id} }` : 'null'}`;
    case 'notify-bots':
      return `notify-bots → { text: ${JSON.stringify(e.text)} }`;
    default:
      return String((e as { type: string }).type);
  }
}

function watchPartyEffectLabel(e: WatchPartyEffect): string {
  switch (e.type) {
    case 'broadcast':
      return `broadcast${e.excludeSender ? ' (excludeSender)' : ''} → { type: '${(e.message as { type?: string })?.type}' }`;
    case 'send-to-sender':
      return `send-to-sender → { type: '${(e.message as { type?: string })?.type}' }`;
    case 'persist-playback':
      return `persist-playback → { videoId: ${e.videoId ? `'${e.videoId}'` : 'null'}, isPlaying: ${e.isPlaying}, position: ${Math.round(e.position)} }`;
    case 'persist-media':
      return `persist-media → { provider: ${e.provider ? `'${e.provider}'` : 'null'} }`;
    case 'resolve-metadata':
      return `resolve-metadata → { uid: '${e.uid}', videoId: '${e.videoId}' } — host がタイトルを取りに行く`;
    default:
      return String((e as { type: string }).type);
  }
}

export function createDemoHost() {
  // ── 状態機械はここで1回だけ作る。注入する述語は全て host 側の関心事。
  const whiteboardApi = createWhiteboardState({
    // 自前ストレージの URL かどうかは host しか知らない（パッケージは判定を持たない）。
    isOwnImageUrl: (url) => url.startsWith(OWN_UPLOAD_PREFIX),
  });
  const watchPartyApi = createWatchParty({
    // ランダム選択も host から注入する。デモを再現可能にするため決定論的に末尾を選ぶ
    // （実アプリは自前の shuffle 実装をそのまま渡す）。
    pickShuffleIndex: (items) => items.length - 1,
  });
  const chatApi = createChatState();

  const members: DemoMember[] = MEMBERS.map((m) => ({
    ...m,
    currentStage: null,
    presence: 'active',
  }));

  let pomodoro: PomodoroState = pomodoroDefaultState();
  let whiteboard: WhiteboardState = whiteboardApi.defaultState();
  let watchParty: WatchPartyState = watchPartyApi.defaultState();
  let chat: ChatState = chatApi.defaultState();

  // 偽の DB。採番・本文・リアクション集計という「host 側の関心事」だけを持つ。
  let nextMessageId = 1;
  const rows = new Map<number, { id: number; name: string; text: string }>();
  const reactions = new Map<number, Map<string, Set<string>>>();
  let strokeSeq = 0;

  /** 入室直後に配る全状態。plugin の状態は apps[appId] に載る（core の契約）。 */
  function spaceStateMessage(selfId: number) {
    return {
      type: 'space-state',
      selfId,
      // ⚠ ホストの配列をそのまま渡さないこと。渡すと store の state が host と同じ
      // オブジェクトを掴み、あとで currentStage を書き換えたときに「配信していないのに
      // クライアントの状態が変わる」ことになる（＝このデモが主張している
      // server-authoritative がその場で嘘になる）。実サーバーは JSON 化して送るので、
      // 参照が共有されることはない。
      members: members.map((m) => ({ ...m })),
      title: 'Mock space',
      apps: { pomodoro, whiteboard },
      settings: {},
    };
  }

  function snapshot() {
    return { members, pomodoro, whiteboard, watchParty, chat };
  }

  // ── plugin（app-state で配る側） ──────────────────────────────
  // pomodoro / whiteboard は「reduce が次の state を返すだけ」なので、host は
  // 差分を作らず最新値をそのまま app-state に載せて全員へ配る。

  function applyPomodoro(
    action: string,
    payload: Record<string, unknown> | undefined,
    call: string,
  ): HostOutcome {
    const result = pomodoroReduce(pomodoro, action, payload);
    if (result === null) {
      return { deliveries: [], steps: [{ call, ret: 'null — 無効か no-op。捨てる', noop: true }] };
    }
    // reduce は { state, effects } を返す。このデモは宣言の永続化（effects の
    // 中身）までは扱わないので state だけ取る。
    const next = result.state;
    pomodoro = next;
    const delay = pomodoroTimerDelay(next);
    return {
      deliveries: [{ message: { type: 'app-state', appId: 'pomodoro', state: next } }],
      steps: [
        {
          call,
          ret: `{ running: ${next.running}, phase: '${next.phase}', cycles: ${next.cycles} }`,
          effects: [
            `timerDelay(state) → ${delay === null ? 'null（動いていない）' : `${Math.round(delay / 1000)}s`}`,
            "broadcast → app-state { appId: 'pomodoro' }",
          ],
        },
      ],
    };
  }

  function applyWhiteboard(
    action: string,
    payload: Record<string, unknown> | undefined,
    call: string,
  ): HostOutcome {
    const result = whiteboardApi.reduce(whiteboard, action, payload);
    if (result === null) {
      return { deliveries: [], steps: [{ call, ret: 'null — 無効か no-op。捨てる', noop: true }] };
    }
    // reduce は { state, effects } か、状態を変えない { effects }（ライブ中継）を
    // 返す。このデモは中継も履歴の永続化も扱わないので、state があるときだけ進める。
    if (!('state' in result)) {
      return {
        deliveries: [],
        steps: [{ call, ret: '{ effects } — 状態は変わらない', noop: true }],
      };
    }
    const next = result.state;
    whiteboard = next;
    return {
      deliveries: [{ message: { type: 'app-state', appId: 'whiteboard', state: next } }],
      steps: [
        {
          call,
          ret: `{ strokes: ${next.strokes.length}, shapes: ${next.shapes.length} }`,
          effects: ["broadcast → app-state { appId: 'whiteboard' }"],
        },
      ],
    };
  }

  // ── watch-party（プレイヤー面のワイヤに直接載る側） ───────────
  // ⚠ こちらは app-state ではない。space-state の core は 'play' や 'queue-update' を
  // 知らない（reduce.ts の case を見れば分かる）。プレイヤーは plugin ではなく
  // スペースの別チャンネルで、受け側もアプリのプレイヤーが自分で持つ。

  function applyWatchParty(
    from: string,
    action: string,
    payload: Record<string, unknown> | undefined,
    call: string,
  ): HostOutcome {
    const deliveries: Delivery[] = [];
    const steps: HostStep[] = [];

    function step(
      stepAction: string,
      stepPayload: Record<string, unknown> | undefined,
      stepCall: string,
    ) {
      const out = watchPartyApi.reduce(watchParty, stepAction, stepPayload);
      if (!out) {
        steps.push({ call: stepCall, ret: 'null — 無効か no-op。捨てる', noop: true });
        return;
      }
      watchParty = out.state;
      steps.push({
        call: stepCall,
        ret: `{ videoId: ${out.state.videoId ? `'${out.state.videoId}'` : 'null'}, isPlaying: ${out.state.isPlaying}, queue: ${out.state.queue.length} }`,
        effects: out.effects.map(watchPartyEffectLabel),
      });
      for (const effect of out.effects) {
        switch (effect.type) {
          case 'broadcast':
            deliveries.push({
              message: effect.message,
              ...(effect.excludeSender ? { exclude: from } : {}),
            });
            break;
          case 'send-to-sender':
            deliveries.push({ message: effect.message, only: from });
            break;
          case 'resolve-metadata':
            // 本物の host は YouTube oEmbed を叩く。ここは「解決できた体」で返す。
            step(
              'resolve-metadata',
              {
                uid: effect.uid,
                kind: effect.kind,
                title: `Resolved title for ${effect.videoId}`,
                durationSec: 180,
              },
              `reduce(state, 'resolve-metadata', { uid: '${effect.uid}', title: '…' })`,
            );
            break;
          default:
            // persist-playback / persist-media は DB 書き込みなので表に出るものが無い
            // （トレースには出ている）。
            break;
        }
      }
    }

    step(action, payload, call);
    return { deliveries, steps };
  }

  // ── チャット ────────────────────────────────────────────────

  function applyChat(
    from: string,
    action: string,
    payload: ChatPayload,
    call: string,
  ): HostOutcome {
    const deliveries: Delivery[] = [];
    const steps: HostStep[] = [];

    function step(stepAction: string, stepPayload: ChatPayload, stepCall: string) {
      const out = chatApi.reduce(chat, stepAction, stepPayload);
      if (!out) {
        steps.push({ call: stepCall, ret: 'null — 無効か no-op。捨てる', noop: true });
        return;
      }
      chat = out.state;
      steps.push({
        call: stepCall,
        ret: `{ pinnedMessage: ${out.state.pinnedMessage ? `#${out.state.pinnedMessage.id}` : 'null'} }`,
        effects: out.effects.map(chatEffectLabel),
      });
      for (const effect of out.effects) {
        switch (effect.type) {
          case 'persist-chat': {
            // id は保存したあとにしか存在しない。だから chat は必ず2段になる。
            const { draft } = effect;
            const id = nextMessageId++;
            rows.set(id, { id, name: draft.by ?? '', text: draft.text });
            const replyTo = draft.replyToId ? (rows.get(draft.replyToId) ?? null) : undefined;
            step(
              'chat-persisted',
              { draft, id, ...(replyTo === undefined ? {} : { replyTo }) },
              `reduce(state, 'chat-persisted', { draft, id: ${id} })`,
            );
            break;
          }
          case 'toggle-reaction': {
            const forMessage = reactions.get(effect.messageId) ?? new Map<string, Set<string>>();
            const names = forMessage.get(effect.emoji) ?? new Set<string>();
            if (names.has(from)) names.delete(from);
            else names.add(from);
            forMessage.set(effect.emoji, names);
            reactions.set(effect.messageId, forMessage);
            const counts: Record<string, { count: number; names: string[] }> = {};
            for (const [emoji, who] of forMessage) {
              if (who.size > 0) counts[emoji] = { count: who.size, names: [...who] };
            }
            step(
              'chat-reaction-toggled',
              { messageId: effect.messageId, reactions: counts },
              `reduce(state, 'chat-reaction-toggled', { messageId: ${effect.messageId}, reactions })`,
            );
            break;
          }
          case 'resolve-message': {
            const found = rows.get(effect.messageId) ?? null;
            step(
              'pin-message-resolved',
              { pinned: found, by: from },
              `reduce(state, 'pin-message-resolved', { pinned: ${found ? `#${found.id}` : 'null'} })`,
            );
            break;
          }
          case 'broadcast':
            deliveries.push({
              message: effect.message,
              ...(effect.excludeSender ? { exclude: from } : {}),
            });
            break;
          case 'send-to-sender':
            deliveries.push({ message: effect.message, only: from });
            break;
          default:
            // persist-pinned / notify-bots は表に出るものが無い。
            break;
        }
      }
    }

    step(action, payload, call);
    return { deliveries, steps };
  }

  /**
   * クライアントの store が `onSend` に流したワイヤメッセージを処理する。
   * 実サーバーの WebSocket ハンドラに相当し、**ここが唯一の入口**。
   */
  function handle(from: MemberName, msg: any): HostOutcome {
    const sender = members.find((m) => m.name === from);
    const senderUid = sender?.uid ?? null;

    switch (msg.type) {
      case 'chat': {
        const isSticker = msg.kind === 'sticker';
        const payload: ChatPayload = {
          text: msg.text,
          clientMsgId: msg.clientMsgId,
          replyToId: msg.replyToId ?? null,
          // ⚠ host-trusted。クライアントの申告ではなく認証済み接続から埋める。
          by: from,
          uid: senderUid,
          avatar: null,
          ...(isSticker
            ? {
                kind: 'sticker',
                imageUrl: msg.imageUrl,
                // allowlist 照合は host が先に済ませて boolean に畳む
                // （非同期な判断なので同期述語には注入できない）。
                stickerAllowed: String(msg.imageUrl ?? '').startsWith(OWN_UPLOAD_PREFIX),
              }
            : {}),
        };
        const call = isSticker
          ? `reduce(state, 'chat', { kind: 'sticker', stickerAllowed: ${payload.stickerAllowed} })`
          : `reduce(state, 'chat', { text: ${JSON.stringify(msg.text)}, by: '${from}' })`;
        return applyChat(from, 'chat', payload, call);
      }
      case 'chat-reaction':
        return applyChat(
          from,
          'chat-reaction',
          { messageId: msg.messageId, emoji: msg.emoji, by: from },
          `reduce(state, 'chat-reaction', { messageId: ${msg.messageId}, emoji: '${msg.emoji}' })`,
        );
      case 'pin-message':
        return applyChat(
          from,
          'pin-message',
          { messageId: msg.messageId, by: from },
          `reduce(state, 'pin-message', { messageId: ${msg.messageId ?? 'null'} })`,
        );
      case 'typing':
        return applyChat(from, 'typing', { by: from }, "reduce(state, 'typing', { by })");

      case 'stage-change': {
        // 🧩スイッチャーの切替。core の member-updated として送信者含む全員へ配る。
        if (!sender) return EMPTY;
        sender.currentStage = msg.stage ?? null;
        return {
          deliveries: [{ message: { type: 'member-updated', member: { ...sender } } }],
          steps: [
            {
              call: `host: stage-change → member-updated { name: '${from}', currentStage: ${msg.stage ? `'${msg.stage}'` : 'null'} }`,
              ret: '状態機械を通さない core のメッセージ（誰が何を見ているか）',
            },
          ],
        };
      }

      // ── スペースアプリ（plugin）宛の操作。appId で状態機械を選ぶ。
      case 'app-action': {
        const call = `reduce(apps['${msg.appId}'], '${msg.action}'${msg.payload ? ', payload' : ''})`;
        if (msg.appId === 'pomodoro') return applyPomodoro(msg.action, msg.payload, call);
        if (msg.appId === 'whiteboard') return applyWhiteboard(msg.action, msg.payload, call);
        return EMPTY;
      }

      // ── プレイヤー面。action 名がそのままワイヤの type になっている。
      case 'load-video':
      case 'play':
      case 'seek':
      case 'queue-add':
      case 'queue-play-next':
      case 'video-ended': {
        const { type, ...payload } = msg;
        return applyWatchParty(
          from,
          type,
          // ⚠ 誰が操作したかはクライアントの申告ではなく、認証済み接続からホストが埋める
          // （host-trusted。addedBy を素通しすると maxPerUser を名乗り分けで回避できる）。
          { ...payload, by: from, byUid: senderUid, addedBy: from, addedByUid: senderUid },
          `reduce(state, '${type}'${Object.keys(payload).length > 0 ? ', payload' : ''})`,
        );
      }

      default:
        return EMPTY;
    }
  }

  /** ポモドーロのフェーズ切替タイマー。予約は消費者（＝ホスト）の仕事。 */
  function pomodoroDelay(): number | null {
    return pomodoroTimerDelay(pomodoro);
  }

  function firePomodoroTimer(): HostOutcome {
    const next = pomodoroOnTimer(pomodoro).state;
    pomodoro = next;
    return {
      deliveries: [{ message: { type: 'app-state', appId: 'pomodoro', state: next } }],
      steps: [
        {
          call: 'timerDelay 経過 → onTimer(state)',
          ret: `{ running: ${next.running}, phase: '${next.phase}', cycles: ${next.cycles} }`,
          effects: ["broadcast → app-state { appId: 'pomodoro' }"],
        },
      ],
    };
  }

  /** ストロークの id はホストが採番する（同じ id が2本できないように）。 */
  function nextStrokeId(prefix: string): string {
    strokeSeq += 1;
    return `${prefix}-${strokeSeq}`;
  }

  /** watch-party の再生位置はウォールクロック外挿。state は秒を持たない。 */
  function currentPosition(): number {
    return watchPartyApi.currentPosition(watchParty);
  }

  return {
    members,
    snapshot,
    spaceStateMessage,
    handle,
    pomodoroDelay,
    firePomodoroTimer,
    nextStrokeId,
    currentPosition,
  };
}

export type DemoHost = ReturnType<typeof createDemoHost>;
