// スペース統合デモの「サーバー役」。React に一切依存しない素の TypeScript。
//
// ⚠ 挙動を再実装しないこと。ここがやるのは `@insession/space` の `createSpace` を **呼ぶ**
// ことと、それが返す effect 記述子を実行することだけで、状態遷移そのものは一行も書かない。
// 判断は全て各パッケージの reduce の中にある。
//
// 実サーバーがやっていることを、そのままの順序で並べてある:
//   1. クライアントから届いたワイヤメッセージを `space.dispatch(extension, action, payload)` へ渡す
//      （振り分け先の解決・reduce の呼び出し・timer の張り直しは `createSpace` がやる）
//   2. 返ってきた effect 記述子を解釈する。`{ type: 'extension', ... }` は各パッケージ固有の
//      効果（採番・保存・タイトル解決）なので、必要なら host がそれを解決して次の action を
//      もう一度 dispatch する（chat の persist-chat → chat-persisted のような2段構成）
//   3. 配信先を決めて配る（全員 / 送信者を除く全員 / 送信者だけ）— `broadcast` / `send-to-sender`
//      の解釈だけがここに残っている。ネットワークが無いデモなので「配る」は疑似クライアントの
//      store へ渡すこと
//
// パッケージ側は 2 の中身（各効果が何を意味するか）と 3 の配信先ラベル以外を一切しない。
// 振り分けそのもの（誰の reduce を呼ぶか）と、accepted 後の state 配信は `createSpace` が持つ。

import {
  type ChatEffect,
  type ChatPayload,
  type ChatState,
  chatExtension,
} from '@insession/extension-chat';
import {
  type PomodoroEffect,
  type PomodoroState,
  pomodoroExtension,
} from '@insession/extension-pomodoro';
import {
  type WatchPartyEffect,
  type WatchPartyState,
  currentPosition as watchPartyCurrentPosition,
  watchPartyExtension,
} from '@insession/extension-watch-party';
import {
  type WhiteboardEffect,
  type WhiteboardState,
  whiteboardExtension,
} from '@insession/extension-whiteboard';
import {
  createSpace,
  type ExtensionClientFacet,
  type Space,
  type SpaceEffect,
  type SpaceExtension,
} from '@insession/space';

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

// ── 各パッケージ固有 effect のラベル（トレース表示用） ────────────────────
// `{ type: 'extension', extension, effect }` で回ってきたものだけがここに来る。broadcast /
// send-to-sender は `createSpace` の側で「core」として素通りするので、ここには現れない。

function chatEffectLabel(e: ChatEffect): string {
  switch (e.type) {
    case 'persist-chat':
      return `persist-chat → { kind: '${e.draft.kind}', text: ${JSON.stringify(e.draft.text)} } — host assigns the id`;
    case 'toggle-reaction':
      return `toggle-reaction → { messageId: ${e.messageId}, emoji: '${e.emoji}' }`;
    case 'resolve-message':
      return `resolve-message → { messageId: ${e.messageId} } — host looks it back up`;
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
    case 'persist-playback':
      return `persist-playback → { videoId: ${e.videoId ? `'${e.videoId}'` : 'null'}, isPlaying: ${e.isPlaying}, position: ${Math.round(e.position)} }`;
    case 'persist-media':
      return `persist-media → { provider: ${e.provider ? `'${e.provider}'` : 'null'} }`;
    case 'resolve-metadata':
      return `resolve-metadata → { uid: '${e.uid}', videoId: '${e.videoId}' } — host fetches the title`;
    default:
      return String((e as { type: string }).type);
  }
}

function pomodoroEffectLabel(e: PomodoroEffect): string {
  switch (e.type) {
    case 'persist-declaration':
      return `persist-declaration → { uid: '${e.uid}', text: ${JSON.stringify(e.text)} }`;
    case 'delete-declaration':
      return `delete-declaration → { uid: '${e.uid}' }`;
    default:
      return String((e as { type: string }).type);
  }
}

function whiteboardEffectLabel(e: WhiteboardEffect): string {
  switch (e.type) {
    case 'persist-relay-history':
      return `persist-relay-history → { players: ${e.players.length}, chains: ${e.chains.length} }`;
    default:
      return String((e as { type: string }).type);
  }
}

function extensionEffectLabel(extension: string, effect: unknown): string {
  switch (extension) {
    case 'chat':
      return chatEffectLabel(effect as ChatEffect);
    case 'watch-party':
      return watchPartyEffectLabel(effect as WatchPartyEffect);
    case 'pomodoro':
      return pomodoroEffectLabel(effect as PomodoroEffect);
    case 'whiteboard':
      return whiteboardEffectLabel(effect as WhiteboardEffect);
    default:
      return `${extension}: ${String((effect as { type?: string })?.type)}`;
  }
}

/** `SpaceEffect` 1件のラベル。`extension` 型だけ中身のラベラーへ委譲する。 */
function effectLabel(e: SpaceEffect): string {
  switch (e.type) {
    case 'broadcast':
      return `broadcast${e.excludeSender ? ' (excludeSender)' : ''} → { type: '${(e.message as { type?: string })?.type}' }`;
    case 'send-to-sender':
      return `send-to-sender → { type: '${(e.message as { type?: string })?.type}' }`;
    case 'schedule-timer':
      return `schedule-timer(${e.extension}) → ${Math.round(e.delayMs / 1000)}s`;
    case 'clear-timer':
      return `clear-timer(${e.extension})`;
    case 'extension':
      return extensionEffectLabel(e.extension, e.effect);
    default:
      return String((e as { type: string }).type);
  }
}

/** client 面のうち、`ctx.t`（i18n）に依存する部分は host ではなく画面側の関心事。 */
export interface DemoHostClientFacets {
  pomodoro?: ExtensionClientFacet;
  whiteboard?: ExtensionClientFacet;
}

export function createDemoHost(clientFacets: DemoHostClientFacets = {}) {
  // ── extension は4つとも「このパッケージが npm に出している factory」で作る。
  // isOwnImageUrl / pickShuffleIndex は host しか知らない述語なので、ここで注入する。
  // client 面（definePluginClient 相当）は画面側から渡されたものをそのまま載せるだけ —
  // ctx.t に依存する以上、host（React 非依存）は中身を持てない。
  const extensions: SpaceExtension[] = [
    {
      ...pomodoroExtension(),
      ...(clientFacets.pomodoro ? { client: clientFacets.pomodoro } : {}),
    },
    {
      ...whiteboardExtension({
        // 自前ストレージの URL かどうかは host しか知らない（パッケージは判定を持たない）。
        isOwnImageUrl: (url) => url.startsWith(OWN_UPLOAD_PREFIX),
      }),
      ...(clientFacets.whiteboard ? { client: clientFacets.whiteboard } : {}),
    },
    watchPartyExtension({
      // ランダム選択も host から注入する。デモを再現可能にするため決定論的に末尾を選ぶ
      // （実アプリは自前の shuffle 実装をそのまま渡す）。
      pickShuffleIndex: (items) => items.length - 1,
    }),
    chatExtension(),
  ];

  // ⚠ broadcastOnAction: false — pomodoro/whiteboard は plugin 形式（core が app-state で
  // 配る）、chat/watch-party は core 形式（パッケージ自身が broadcast / send-to-sender を返し、
  // space-state の受信 case に直接乗る）で、この2つの配信方式が同居する。既定の
  // broadcastOnAction は registry 単位（extension ごとに変えられない）なので、chat/watch-party
  // にまで自動で app-state を付けてしまう。それは examples/space.mdx が明示している「chat は
  // app-state を経由しない」「watch-party は space-state の外側」という境界と矛盾するため、
  // ここでは自動配信を止めて、pomodoro/whiteboard の分だけ host が自分で組み立てる
  // （下記 `withAppStateBroadcast`）。registry.ts のコメントが言う
  // "Set false for a host that batches or routes its own updates" はまさにこのケース。
  const space: Space = createSpace({ extensions, broadcastOnAction: false });

  const members: DemoMember[] = MEMBERS.map((m) => ({
    ...m,
    currentStage: null,
    presence: 'active',
  }));

  // 偽の DB。採番・本文・リアクション集計という「host 側の関心事」だけを持つ。
  let nextMessageId = 1;
  const rows = new Map<number, { id: number; name: string; text: string }>();
  const reactions = new Map<number, Map<string, Set<string>>>();
  let strokeSeq = 0;

  // `schedule-timer` / `clear-timer` の最新値。`armTimers()` を毎回呼ぶ代わりに、dispatch の
  // たびに来る effect を拾うだけで足りる（`createSpace` が変化のたびに必ず出してくれるので）。
  const armedDelay = new Map<string, number | null>();

  /** 入室直後に配る全状態。plugin の状態は apps[appId] に載る（core の契約）。 */
  function spaceStateMessage(selfId: number) {
    const ext = space.getState().extensions;
    return {
      type: 'space-state',
      selfId,
      // ⚠ ホストの配列をそのまま渡さないこと。渡すと store の state が host と同じ
      // オブジェクトを掴み、あとで currentStage を書き換えたときに「配信していないのに
      // クライアントの状態が変わる」ことになる（＝このデモが主張している
      // server-authoritative がその場で嘘になる）。実サーバーは JSON 化して送るので、
      // 参照が共有されることはない。extension の slice は各パッケージが変化のたびに
      // 新しいオブジェクトへ差し替える契約なので、そちらはそのまま渡してよい。
      members: members.map((m) => ({ ...m })),
      title: 'Mock space',
      apps: { pomodoro: ext.pomodoro, whiteboard: ext.whiteboard },
      settings: {},
    };
  }

  function snapshot() {
    const ext = space.getState().extensions;
    return {
      members,
      pomodoro: ext.pomodoro as PomodoroState,
      whiteboard: ext.whiteboard as WhiteboardState,
      watchParty: ext['watch-party'] as WatchPartyState,
      chat: ext.chat as ChatState,
    };
  }

  // ── plugin 形式（app-state で配る）の extension だけの一覧。chat/watch-party はここに
  // 入れない — 自分の broadcast/send-to-sender を素通りさせるだけで、app-state は出さない
  // (examples/space.mdx が教えている境界そのもの)。
  const APP_STATE_EXTENSIONS = new Set(['pomodoro', 'whiteboard']);

  function buildAppStateBroadcast(extension: string, state: unknown): SpaceEffect {
    return { type: 'broadcast', message: { type: 'app-state', appId: extension, state } };
  }

  /**
   * `broadcastOnAction: false` にした分を、pomodoro/whiteboard についてだけ host が肩代わりする。
   *
   * 「変わったか」は `registry.ts` 自身が言っている契約をそのまま借りる: accepted かつ
   * state が変わったときだけ、その extension の slice は **新しいオブジェクトに差し替わる**
   * （`finish()` の `!changed` 分岐は同じ `state` 参照をそのまま返す）。なので dispatch の前後で
   * `space.getState().extensions[extension]` の参照を比較すれば、`registry.ts` の `changed`
   * と同じ判定になる — 変わっていないのに broadcast することは無い。
   */
  function withAppStateBroadcast(
    extension: string,
    prevSlice: unknown,
    effects: SpaceEffect[],
  ): SpaceEffect[] {
    if (!APP_STATE_EXTENSIONS.has(extension)) return effects;
    const nextSlice = space.getState().extensions[extension];
    if (nextSlice === prevSlice) return effects;
    // 元の `finish()` と同じ並び: state の broadcast が先、その extension 自身の effect
    // （persist-declaration 等）と timer effect は後ろに続く。
    return [buildAppStateBroadcast(extension, nextSlice), ...effects];
  }

  // ── effect の解釈。`space.dispatch` / `space.fireTimer` が返す `SpaceEffect[]` を1箇所で
  // さばく。「配信先を決める」のはここだけで、reduce を呼ぶこと自体はしない。

  function processEffects(
    effects: SpaceEffect[],
    from: MemberName | null,
    call: string,
    deliveries: Delivery[],
    steps: HostStep[],
  ) {
    if (effects.length === 0) {
      steps.push({
        call,
        ret: 'no effects — invalid, rejected, or a no-op. discarded',
        noop: true,
      });
      return;
    }
    steps.push({ call, effects: effects.map(effectLabel) });
    for (const effect of effects) {
      switch (effect.type) {
        case 'broadcast':
          deliveries.push({
            message: effect.message,
            ...(effect.excludeSender && from ? { exclude: from } : {}),
          });
          break;
        case 'send-to-sender':
          if (from) deliveries.push({ message: effect.message, only: from });
          break;
        case 'schedule-timer':
          armedDelay.set(effect.extension, effect.delayMs);
          break;
        case 'clear-timer':
          armedDelay.set(effect.extension, null);
          break;
        case 'extension':
          cascade(effect.extension, effect.effect, from, deliveries, steps);
          break;
        default:
          break;
      }
    }
  }

  /** dispatch してその結果を同じ deliveries/steps へ積む。cascade からの再帰呼び出し用。 */
  function runFlow(
    extension: string,
    action: string,
    payload: unknown,
    from: MemberName | null,
    call: string,
    deliveries: Delivery[],
    steps: HostStep[],
  ) {
    const prevSlice = space.getState().extensions[extension];
    const effects = space.dispatch(extension, action, payload);
    processEffects(
      withAppStateBroadcast(extension, prevSlice, effects),
      from,
      call,
      deliveries,
      steps,
    );
  }

  /**
   * `{ type: 'extension', ... }` effect のうち、host がもう一段 reduce を呼び直す必要がある
   * もの（採番・タイトル解決）だけを扱う。それ以外（DB書き込みだけのもの）はラベルが
   * 既に積まれているので、ここでは何もしない。
   */
  function cascade(
    extension: string,
    effect: unknown,
    from: MemberName | null,
    deliveries: Delivery[],
    steps: HostStep[],
  ) {
    if (extension === 'chat') {
      const e = effect as ChatEffect;
      switch (e.type) {
        case 'persist-chat': {
          // id は保存したあとにしか存在しない。だから chat は必ず2段になる。
          const { draft } = e;
          const id = nextMessageId++;
          rows.set(id, { id, name: draft.by ?? '', text: draft.text });
          const replyTo = draft.replyToId ? (rows.get(draft.replyToId) ?? null) : undefined;
          runFlow(
            'chat',
            'chat-persisted',
            { draft, id, ...(replyTo === undefined ? {} : { replyTo }) },
            from,
            `reduce(state, 'chat-persisted', { draft, id: ${id} })`,
            deliveries,
            steps,
          );
          return;
        }
        case 'toggle-reaction': {
          const forMessage = reactions.get(e.messageId) ?? new Map<string, Set<string>>();
          const names = forMessage.get(e.emoji) ?? new Set<string>();
          if (from) {
            if (names.has(from)) names.delete(from);
            else names.add(from);
          }
          forMessage.set(e.emoji, names);
          reactions.set(e.messageId, forMessage);
          const counts: Record<string, { count: number; names: string[] }> = {};
          for (const [emoji, who] of forMessage) {
            if (who.size > 0) counts[emoji] = { count: who.size, names: [...who] };
          }
          runFlow(
            'chat',
            'chat-reaction-toggled',
            { messageId: e.messageId, reactions: counts },
            from,
            `reduce(state, 'chat-reaction-toggled', { messageId: ${e.messageId}, reactions })`,
            deliveries,
            steps,
          );
          return;
        }
        case 'resolve-message': {
          const found = rows.get(e.messageId) ?? null;
          runFlow(
            'chat',
            'pin-message-resolved',
            { pinned: found, by: from },
            from,
            `reduce(state, 'pin-message-resolved', { pinned: ${found ? `#${found.id}` : 'null'} })`,
            deliveries,
            steps,
          );
          return;
        }
        default:
          // persist-pinned / notify-bots は DB 書き込みだけ。表に出るものはラベルで足りる。
          return;
      }
    }

    if (extension === 'watch-party') {
      const e = effect as WatchPartyEffect;
      if (e.type === 'resolve-metadata') {
        // 本物の host は YouTube oEmbed を叩く。ここは「解決できた体」で返す。
        runFlow(
          'watch-party',
          'resolve-metadata',
          { uid: e.uid, kind: e.kind, title: `Resolved title for ${e.videoId}`, durationSec: 180 },
          from,
          `reduce(state, 'resolve-metadata', { uid: '${e.uid}', title: '…' })`,
          deliveries,
          steps,
        );
      }
      return;
    }

    // pomodoro の persist-declaration/delete-declaration、whiteboard の
    // persist-relay-history は DB 書き込みだけで、host が呼び直す reduce は無い。
  }

  function runAction(
    extension: string,
    action: string,
    payload: unknown,
    from: MemberName,
    call: string,
  ): HostOutcome {
    const deliveries: Delivery[] = [];
    const steps: HostStep[] = [];
    runFlow(extension, action, payload, from, call, deliveries, steps);
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
        return runAction('chat', 'chat', payload, from, call);
      }
      case 'chat-reaction':
        return runAction(
          'chat',
          'chat-reaction',
          { messageId: msg.messageId, emoji: msg.emoji, by: from },
          from,
          `reduce(state, 'chat-reaction', { messageId: ${msg.messageId}, emoji: '${msg.emoji}' })`,
        );
      case 'pin-message':
        return runAction(
          'chat',
          'pin-message',
          { messageId: msg.messageId, by: from },
          from,
          `reduce(state, 'pin-message', { messageId: ${msg.messageId ?? 'null'} })`,
        );
      case 'typing':
        return runAction('chat', 'typing', { by: from }, from, "reduce(state, 'typing', { by })");

      case 'stage-change': {
        // 🧩スイッチャーの切替。`currentStage` は space-state の core（member-updated）が
        // 運ぶだけの値で、どの extension の slice でもない。だから dispatch は通さず、host が
        // 直接 member-updated を組み立てて全員（送信者含む）へ配る。
        if (!sender) return EMPTY;
        sender.currentStage = msg.stage ?? null;
        return {
          deliveries: [{ message: { type: 'member-updated', member: { ...sender } } }],
          steps: [
            {
              call: `host: stage-change → member-updated { name: '${from}', currentStage: ${msg.stage ? `'${msg.stage}'` : 'null'} }`,
              ret: 'a core message that bypasses every state machine (who is looking at what)',
            },
          ],
        };
      }

      // ── スペースアプリ（plugin）宛の操作。appId で extension を選ぶ。
      case 'app-action': {
        const call = `reduce(apps['${msg.appId}'], '${msg.action}'${msg.payload ? ', payload' : ''})`;
        if (msg.appId === 'pomodoro' || msg.appId === 'whiteboard') {
          return runAction(msg.appId, msg.action, msg.payload, from, call);
        }
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
        return runAction(
          'watch-party',
          type,
          // ⚠ 誰が操作したかはクライアントの申告ではなく、認証済み接続からホストが埋める
          // （host-trusted。addedBy を素通しすると maxPerUser を名乗り分けで回避できる）。
          { ...payload, by: from, byUid: senderUid, addedBy: from, addedByUid: senderUid },
          from,
          `reduce(state, '${type}'${Object.keys(payload).length > 0 ? ', payload' : ''})`,
        );
      }

      default:
        return EMPTY;
    }
  }

  /** ポモドーロのフェーズ切替タイマー。予約は消費者（＝ホスト）の仕事。 */
  function pomodoroDelay(): number | null {
    return armedDelay.get('pomodoro') ?? null;
  }

  function firePomodoroTimer(): HostOutcome {
    const deliveries: Delivery[] = [];
    const steps: HostStep[] = [];
    const prevSlice = space.getState().extensions.pomodoro;
    const effects = space.fireTimer('pomodoro');
    processEffects(
      withAppStateBroadcast('pomodoro', prevSlice, effects),
      null,
      "timerDelay elapsed → space.fireTimer('pomodoro')",
      deliveries,
      steps,
    );
    return { deliveries, steps };
  }

  /** ストロークの id はホストが採番する（同じ id が2本できないように）。 */
  function nextStrokeId(prefix: string): string {
    strokeSeq += 1;
    return `${prefix}-${strokeSeq}`;
  }

  /** watch-party の再生位置はウォールクロック外挿。state は秒を持たない。 */
  function currentPosition(): number {
    return watchPartyCurrentPosition(space.getState().extensions['watch-party'] as WatchPartyState);
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
    /** client 面（PluginClient 形）。`createSpaceStore({ plugins })` にそのまま渡せる。 */
    clientExtensions: () => space.clientExtensions(),
  };
}

export type DemoHost = ReturnType<typeof createDemoHost>;
