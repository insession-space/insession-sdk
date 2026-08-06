// `@insession/*` を全部まとめて動かす統合デモ。1つのスペースに2人が居て、
// ポモドーロ・ホワイトボード・プレイヤー・チャットが同居している。
//
// ⚠ 挙動を再実装しないこと。状態遷移は全て npm に出ているパッケージの reduce が持つ。
// このファイルがやるのは「クライアント2枚を組み立てて描く」ことだけで、サーバー役は
// space-demo-host.ts に分けてある（あちらは React に依存しない — 実サーバーと同じ形）。
//
// 個別デモ(/examples/*)が1パッケージの中を見せるのに対して、ここで見せたいのは **境界**:
//
//  (a) plugin（pomodoro / whiteboard）は app-state で配られ、core が apps[appId] に格納する。
//      各 plugin のクライアント面は PluginClient として core に差し込まれ、ログ行と効果音の
//      effect だけを返す（core は plugin の名前も音色も知らない）
//  (b) チャットは plugin ではなく core。extension-chat が返す broadcast / chat-ack が、
//      そのまま space-state の受信 case に噛み合う（送信者だけ ack を受け取る非対称も込み）
//  (c) プレイヤー（watch-party）は **app-state ではない**。space-state の core は 'play' も
//      'queue-update' も知らないので、受け側はアプリのプレイヤーが自分で持つ。境界の外側にも
//      パッケージは置ける、という例
//  (d) 送信は必ずサーバーを1周する。🧩スイッチャーのタブ切替すら server-authoritative で、
//      自分の画面のタブは member-updated が返ってきて初めて変わる
//
// ⚠ setState の updater の中で setTrace を呼ばないこと。updater は React に二度呼ばれうるので
// （StrictMode の二重呼び出し）、トレースが重複して積まれる。state は素直に読んで使う。

import { Button, HStack, Lozenge, SegmentedControl } from '@insession/design-system';
import type { PomodoroState } from '@insession/extension-pomodoro';
import type { WhiteboardState } from '@insession/extension-whiteboard';
import type { ExtensionClientFacet } from '@insession/space';
import { createSpaceStore, type SpaceEffect, type SpaceStore } from '@insession/space-state';
import { useEffect, useRef, useState } from 'react';
import {
  createDemoHost,
  type Delivery,
  type DemoHost,
  type HostStep,
  MEMBERS,
  type MemberName,
  OWN_STICKER,
  OWN_UPLOAD_PREFIX,
  VIDEOS,
} from './space-demo-host.ts';
import { pushEntry, type TraceEntry, TraceList } from './Trace.tsx';
import { useSpaceState } from './use-space-state.ts';

/** space-state の core が受信 case を持つメッセージ。これ以外はプレイヤー面へ回す。 */
const CORE_MESSAGE_TYPES = new Set([
  'space-state',
  'member-joined',
  'member-left',
  'member-updated',
  'chat',
  'chat-ack',
  'chat-reaction-update',
  'message-pinned',
  'typing',
  'app-state',
  'app-relay',
]);

const STAGES = [
  { id: 'pomodoro', label: 'pomodoro' },
  { id: 'whiteboard', label: 'whiteboard' },
  { id: 'player', label: 'watch party' },
] as const;

type StageId = (typeof STAGES)[number]['id'];

/**
 * 文言解決関数。i18n の `t` をそのまま渡せる契約なので、デモでは辞書を1つ持つだけ。
 * ⚠ core も plugin も文面を持たない — キーを投げ返すだけなのがこの契約の要点。
 */
const LABELS: Record<string, string> = {
  'log.joined': 'joined',
  'log.pomodoro.work': 'work phase started',
  'log.pomodoro.break': 'break time',
  'log.pomodoro.started': 'timer started',
  'log.pomodoro.paused': 'timer paused',
  'log.whiteboard.cleared': 'cleared the board',
  'log.whiteboardSwitch': 'switched to the whiteboard',
  // ⚠ ピン留めのログ行は core（space-state）が出す。plugin の分だけ埋めても
  // `<log.messagePinned>` が画面に出るので、core が引くキーも揃えること。
  'log.messagePinned': 'pinned a message',
  'log.messageUnpinned': 'removed the pin',
};

const t = (key: string) => LABELS[key] ?? `<${key}>`;

// ── plugin のクライアント面 ──────────────────────────────────────
// core(reduce.ts) は app-state を apps[appId] に格納することしか知らない。
// 「フェーズが変わったらログ行と効果音」のような plugin 固有の畳み込みは、この記述子が持つ。

type PomodoroLocal = { phase: string; running: boolean };

// ⚠ id は持たせない。`@insession/space` の `SpaceExtension.client` は id を extension.name から
// 補うので（`space.clientExtensions()` が `{ id: ext.name, ...client }` を返す）、ここで書くと
// host 側の名前と二重管理になる。id を持たない `ExtensionClientFacet` がそのための形。
const pomodoroClient: ExtensionClientFacet = {
  // ⚠ 直前値を記録するだけに徹する。ここで判定して effect を出すと、入室のたびに鳴る。
  initLocal: (appState) => ({
    phase: (appState as PomodoroState | undefined)?.phase ?? 'work',
    running: (appState as PomodoroState | undefined)?.running ?? false,
  }),
  onAppState: ({ local, msg, ctx }) => {
    const next = msg.state as PomodoroState;
    const prev = local as PomodoroLocal | undefined;
    const nextLocal: PomodoroLocal = { phase: next.phase, running: next.running };
    if (prev && prev.phase === next.phase && prev.running === next.running) {
      return { local: nextLocal };
    }
    const phaseChanged = !prev || prev.phase !== next.phase;
    const key = phaseChanged
      ? `log.pomodoro.${next.phase}`
      : next.running
        ? 'log.pomodoro.started'
        : 'log.pomodoro.paused';
    return {
      local: nextLocal,
      lines: [{ kind: 'log', icon: 'timer', by: 'pomodoro', text: ctx.t(key), appId: 'pomodoro' }],
      // core は音そのものを知らない。appId 付きで投げ返すだけ。
      effects: phaseChanged
        ? [{ type: 'plugin-sound' as const, appId: 'pomodoro', sound: next.phase }]
        : [],
    };
  },
};

type WhiteboardLocal = { marks: number };

const whiteboardClient: ExtensionClientFacet = {
  initLocal: (appState) => {
    const s = appState as WhiteboardState | undefined;
    return { marks: (s?.strokes.length ?? 0) + (s?.shapes.length ?? 0) };
  },
  onAppState: ({ local, msg, ctx }) => {
    const next = msg.state as WhiteboardState;
    const marks = next.strokes.length + next.shapes.length;
    const prev = local as WhiteboardLocal | undefined;
    const nextLocal: WhiteboardLocal = { marks };
    // 「全部消えた」ときだけログにする（1本ずつの追加でチャットを埋めない）。
    if (prev && prev.marks > 0 && marks === 0) {
      return {
        local: nextLocal,
        lines: [
          {
            kind: 'log',
            icon: 'edit',
            by: 'whiteboard',
            text: ctx.t('log.whiteboard.cleared'),
            appId: 'whiteboard',
          },
        ],
      };
    }
    return { local: nextLocal };
  },
};

// ── プレイヤー面（core の外） ────────────────────────────────────
// space-state は 'play' も 'queue-update' も知らないので、届いたワイヤメッセージを
// クライアントが自分で畳む。⚠ これは状態機械ではなく **表示のための射影**（本物の
// アプリでもプレイヤーコンポーネントがやっていること）。判断は全てサーバー側の reduce にある。

type QueueItem = { uid: string; videoId: string; title: string | null; addedBy: string | null };

type PlayerView = {
  videoId: string | null;
  title: string | null;
  isPlaying: boolean;
  /** 受信時点の再生位置と、その受信時刻。表示は今との差で外挿する（state は秒を持たない）。 */
  position: number;
  since: number;
  queue: QueueItem[];
  notice: string | null;
};

const emptyPlayerView: PlayerView = {
  videoId: null,
  title: null,
  isPlaying: false,
  position: 0,
  since: 0,
  queue: [],
  notice: null,
};

function applyPlayerMessage(view: PlayerView, msg: any): PlayerView {
  switch (msg.type) {
    case 'load-video':
      return {
        ...view,
        videoId: String(msg.videoId),
        title: null,
        isPlaying: true,
        position: 0,
        since: Date.now(),
        notice: null,
      };
    case 'play':
      return { ...view, isPlaying: true, position: Number(msg.position) || 0, since: Date.now() };
    case 'seek':
      return {
        ...view,
        isPlaying: Boolean(msg.isPlaying),
        position: Number(msg.position) || 0,
        since: Date.now(),
      };
    case 'queue-update':
      return {
        ...view,
        queue: (msg.queue as any[]).map((q) => ({
          uid: String(q.uid),
          videoId: String(q.videoId),
          title: (q.title as string | null) ?? null,
          addedBy: (q.addedBy as string | null) ?? null,
        })),
      };
    case 'history-update': {
      // 今流れているものの解決済みタイトルは history の先頭に載って戻ってくる。
      const head = (msg.history as any[])[0];
      if (!head || head.videoId !== view.videoId) return view;
      return { ...view, title: (head.title as string | null) ?? null };
    }
    case 'queue-rejected':
      return { ...view, notice: `queue-rejected: ${msg.reason} (limit ${msg.limit})` };
    default:
      return view;
  }
}

function displayPosition(view: PlayerView): number {
  if (!view.isPlaying) return view.position;
  return view.position + (Date.now() - view.since) / 1000;
}

function mmss(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** ポモドーロの残り秒。動作中は endsAt から引く（state は秒を持たない）。 */
function pomodoroSecondsLeft(s: PomodoroState | undefined): number {
  if (!s) return 0;
  if (!s.running || s.endsAt === null) return s.remaining;
  return Math.max(0, Math.round((s.endsAt - Date.now()) / 1000));
}

// ── デモ本体 ────────────────────────────────────────────────────

type Stores = Record<MemberName, SpaceStore>;

export default function SpaceDemo() {
  // host も store も1回だけ作る（毎レンダリングで作り直すとスペースが消える）。
  const hostRef = useRef<DemoHost | null>(null);
  const storesRef = useRef<Stores | null>(null);
  if (hostRef.current === null) {
    // pomodoro/whiteboard の client 記述子はここ(画面側)で作るが、host に渡して
    // `createSpace` の extension オブジェクトへ載せてもらう。id は host 側の extension 名
    // (`space.clientExtensions()` が付与する)がそのまま使われるので、ここでは書かない。
    hostRef.current = createDemoHost({ pomodoro: pomodoroClient, whiteboard: whiteboardClient });
  }
  if (storesRef.current === null) {
    const host = hostRef.current;
    storesRef.current = Object.fromEntries(
      MEMBERS.map((m) => [
        m.name,
        createSpaceStore({
          selfName: m.name,
          t,
          getPresence: () => 'active',
          // 親パッケージ(`@insession/space`)が持つ client 面をそのまま渡す。手書きの配列を
          // ここへ直接置かない — host の extension 定義との二重管理になる。
          plugins: host.clientExtensions(),
        }),
      ]),
    ) as Stores;
  }
  const host = hostRef.current;
  const stores = storesRef.current;

  const [acting, setActing] = useState<MemberName>('Alice');
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  const [players, setPlayers] = useState<Record<MemberName, PlayerView>>({
    Alice: emptyPlayerView,
    Bob: emptyPlayerView,
  });
  // ホスト側の状態が動いたことを示すだけのカウンタ（タイマーの張り直しに使う）。
  const [hostVersion, setHostVersion] = useState(0);
  // 時計の再描画専用。state は触らない。
  const [, setTick] = useState(0);

  // 入力中表示の自動クリアタイマー。effect で受け取って消費者（＝この画面）が張る。
  const typingTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  /** ホストの処理結果を各クライアントへ配る。ここがワイヤの代わり。 */
  function deliver(deliveries: Delivery[], steps: HostStep[]) {
    // プレイヤー面は core の外なので React state で持つ。⚠ 直前の render の players を
    // 読まないこと（同じ tick に配信が2件並ぶと片方が消える）。updater の中で畳む。
    const playerMessages: Partial<Record<MemberName, any[]>> = {};
    for (const d of deliveries) {
      for (const m of MEMBERS) {
        if (d.only && d.only !== m.name) continue;
        if (d.exclude === m.name) continue;
        if (CORE_MESSAGE_TYPES.has(d.message?.type)) {
          stores[m.name].receive(d.message);
        } else {
          const queued = playerMessages[m.name] ?? [];
          queued.push(d.message);
          playerMessages[m.name] = queued;
        }
      }
    }
    if (Object.keys(playerMessages).length > 0) {
      setPlayers((prev) => {
        const next = { ...prev };
        for (const [name, messages] of Object.entries(playerMessages)) {
          next[name as MemberName] = (messages as any[]).reduce(
            applyPlayerMessage,
            prev[name as MemberName],
          );
        }
        return next;
      });
    }
    if (steps.length > 0) {
      setTrace((prev) => steps.reduce<TraceEntry[]>((acc, s) => pushEntry(acc, s), prev));
    }
    setHostVersion((n) => n + 1);
  }

  const deliverRef = useRef(deliver);
  deliverRef.current = deliver;

  // 配線: store が onSend に流したものをホストへ渡し、返ってきた配信を各 store へ戻す。
  // 併せて各 store の effect（音・通知・入力中タイマー）もトレースへ出す。
  useEffect(() => {
    const unsubscribes: (() => void)[] = [];
    for (const m of MEMBERS) {
      const store = stores[m.name];
      unsubscribes.push(
        store.onSend((msg: any) => {
          setTrace((prev) =>
            pushEntry(prev, {
              call: `[${m.name}] store.send({ type: '${msg.type}' }) → to the host`,
            }),
          );
          // ⚠ ここを同期で処理しないこと。ワイヤは非同期で、送信は必ず「送ってから」返る。
          // store.chat.send() は send() を呼んだ **あとに** ローカルエコー行を積むので、
          // 同期で配ると chat-ack が「まだ存在しない行」を探しに行き、送信者の行がずっと
          // id: null のまま残る（＝リアクションもピン留めもできない行になる）。
          queueMicrotask(() => {
            const outcome = host.handle(m.name, msg);
            deliverRef.current(outcome.deliveries, outcome.steps);
          });
        }),
      );
      unsubscribes.push(
        store.onEffect((effect: SpaceEffect) => {
          // 入力中表示の自動クリアだけは消費者が実際に張る（effect は記述子でしかない）。
          if (effect.type === 'typing-timer') {
            const existing = typingTimers.current.get(effect.name);
            if (existing) clearTimeout(existing);
            typingTimers.current.set(
              effect.name,
              setTimeout(() => store.clearTyping(effect.name), 3000),
            );
          } else if (effect.type === 'typing-timer-clear') {
            const existing = typingTimers.current.get(effect.name);
            if (existing) clearTimeout(existing);
            typingTimers.current.delete(effect.name);
          }
          // 音も通知も鳴らさない。届いた記述子をそのまま出すだけ。
          setTrace((prev) =>
            pushEntry(prev, { call: `[${m.name}] onEffect`, effects: [JSON.stringify(effect)] }),
          );
        }),
      );
    }
    return () => {
      for (const un of unsubscribes) un();
      for (const timer of typingTimers.current.values()) clearTimeout(timer);
      typingTimers.current.clear();
    };
  }, [host, stores]);

  // 入室。両クライアントに全状態を配る（実サーバーが join 直後に送るもの）。
  const joined = useRef(false);
  useEffect(() => {
    if (joined.current) return;
    joined.current = true;
    for (const m of MEMBERS) stores[m.name].receive(host.spaceStateMessage(m.id));
    setTrace((prev) =>
      pushEntry(prev, {
        call: 'host: space-state broadcast to both clients',
        ret: 'apps carries the initial pomodoro / whiteboard state',
      }),
    );
  }, [host, stores]);

  // ポモドーロのフェーズ切替はホストが予約する（timerDelay → onTimer）。
  //
  // ⚠ hostVersion は本文で読んでいないが、依存から外さないこと。host の state は React の
  // 外（ミュータブルなクロージャ）に居るので、ホストが動いたことを React に伝える手段が
  // このカウンタしかない。外すとタイマーが張り直されず、最初のフェーズで止まる。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 上記のとおり意図的な依存
  useEffect(() => {
    const delay = host.pomodoroDelay();
    if (delay === null) return;
    const id = setTimeout(() => {
      const outcome = host.firePomodoroTimer();
      deliverRef.current(outcome.deliveries, outcome.steps);
    }, delay);
    return () => clearTimeout(id);
  }, [host, hostVersion]);

  // 時計だけを描き直す。state は触らない。
  const someClockRunning = players[acting].isPlaying || host.snapshot().pomodoro.running;
  useEffect(() => {
    if (!someClockRunning) return;
    const id = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [someClockRunning]);

  // 2枚とも購読する。両方を出すことで「同じスペースを共有している」ことが画面で見える。
  const aliceState = useSpaceState(stores.Alice);
  const bobState = useSpaceState(stores.Bob);
  const states: Record<MemberName, any> = { Alice: aliceState, Bob: bobState };
  const state = states[acting];
  const store = stores[acting];
  const player = players[acting];

  const self = state.members.find((m: any) => m.name === acting);
  const activeStage: StageId = (self?.currentStage as StageId | null) ?? 'pomodoro';
  const pomodoro = state.apps.pomodoro as PomodoroState | undefined;
  const whiteboard = state.apps.whiteboard as WhiteboardState | undefined;

  /** store が持たない生のワイヤ送信（plugin 操作 / プレイヤー操作）。 */
  function send(msg: Record<string, unknown>) {
    store.send(msg);
  }

  function appAction(appId: string, action: string, payload?: Record<string, unknown>) {
    send({ type: 'app-action', appId, action, ...(payload ? { payload } : {}) });
  }

  return (
    <div className="demo not-content">
      <div className="demo-bar">
        <span>@insession/* — one space</span>
        <span className="demo-api">space-state / 4 state machines</span>
      </div>

      <div className="demo-pane">
        <p className="demo-label">acting as — actions are broadcast to both clients</p>
        <SegmentedControl
          ariaLabel="acting as"
          items={MEMBERS.map((m) => ({ value: m.name, label: `as ${m.name}` }))}
          value={acting}
          onValueChange={(v) => setActing(v as MemberName)}
        />
      </div>

      <div className="space-screen">
        {/* ── 在室メンバー。currentStage も chatLines もサーバー由来なので、
             2人の値が揃っていることがそのまま「状態を共有している」証拠になる。 */}
        <div className="space-rail">
          <p className="demo-label">members</p>
          {MEMBERS.map((m) => {
            const view = states[m.name];
            const member = view.members.find((x: any) => x.name === m.name);
            return (
              <div
                key={m.name}
                className="space-member"
                data-self={acting === m.name ? '' : undefined}
              >
                <span className="space-member-name">{m.name}</span>
                <span className="space-member-meta">stage: {member?.currentStage ?? '—'}</span>
                <span className="space-member-meta">
                  chatLines: {view.chatLines.length} · connected: {String(view.connected)}
                </span>
              </div>
            );
          })}
          <span className="space-member-meta">
            typing: {state.typingUsers.length > 0 ? state.typingUsers.join(', ') : '—'}
          </span>
        </div>

        {/* ── 🧩スイッチャー。タブの切替もサーバーを1周する。 */}
        <div className="space-stage">
          <div className="space-tabs">
            <SegmentedControl
              ariaLabel="stage"
              items={STAGES.map((s) => ({ value: s.id, label: s.label }))}
              value={activeStage}
              onValueChange={(v) => store.stage.change(v as StageId)}
            />
          </div>

          {activeStage === 'pomodoro' && (
            <>
              {/* ⚠ DS の `RingTimer` は使わない。生の秒数をそのまま描画するので 25 分が
                  `25:00` ではなく `1500` になる（PomodoroDemo.tsx の同じ箇所に理由の詳細）。 */}
              <p className="demo-clock" data-phase={pomodoro?.phase}>
                {mmss(pomodoroSecondsLeft(pomodoro))}
              </p>
              <div className="demo-chips">
                <Lozenge tone="neutral">phase: {pomodoro?.phase ?? '—'}</Lozenge>
                <Lozenge tone={pomodoro?.running ? 'success' : 'neutral'} dot={pomodoro?.running}>
                  {pomodoro?.running ? 'running' : 'stopped'}
                </Lozenge>
                <Lozenge tone="neutral">cycles: {pomodoro?.cycles ?? 0}</Lozenge>
              </div>
              <HStack gap="sm" wrap>
                <Button
                  size="sm"
                  variant={pomodoro?.running ? 'secondary' : 'primary'}
                  onClick={() => appAction('pomodoro', 'start')}
                >
                  start
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => appAction('pomodoro', 'pause')}
                >
                  pause
                </Button>
                <Button size="sm" variant="secondary" onClick={() => appAction('pomodoro', 'skip')}>
                  skip
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => appAction('pomodoro', 'reset')}
                >
                  reset
                </Button>
              </HStack>
            </>
          )}

          {activeStage === 'whiteboard' && (
            <>
              <div className="demo-chips">
                <Lozenge tone="neutral">strokes: {whiteboard?.strokes.length ?? 0}</Lozenge>
                <Lozenge tone="neutral">shapes: {whiteboard?.shapes.length ?? 0}</Lozenge>
              </div>
              <HStack gap="sm" wrap>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() =>
                    appAction('whiteboard', 'add-stroke', {
                      stroke: {
                        id: host.nextStrokeId('stroke'),
                        type: 'freedraw',
                        x: 10,
                        y: 10,
                        width: 40,
                        height: 40,
                        style: { fill: 'none', stroke: '#1e1e1e', strokeWidth: 4, opacity: 1 },
                        points: [
                          { x: 0, y: 0 },
                          { x: 20, y: 30 },
                          { x: 40, y: 10 },
                        ],
                      },
                    })
                  }
                >
                  add stroke
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    appAction('whiteboard', 'add-shape', {
                      shape: {
                        id: host.nextStrokeId('shape'),
                        type: 'rectangle',
                        x: 20,
                        y: 20,
                        width: 80,
                        height: 60,
                        style: { fill: '#ffffff', stroke: '#1e1e1e', strokeWidth: 2, opacity: 1 },
                      },
                    })
                  }
                >
                  add shape
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => appAction('whiteboard', 'clear')}
                >
                  clear
                </Button>
              </HStack>
              <p className="demo-label">note</p>
              <p className="space-note">
                <code>isOwnImageUrl</code>, the predicate that decides whether an uploaded image is
                from own storage, is injected by the host (<code>{OWN_UPLOAD_PREFIX}…</code>). See
                it actually reject one on the <a href="/examples/whiteboard/">whiteboard</a>{' '}
                example, which has the drawing relay game.
              </p>
            </>
          )}

          {activeStage === 'player' && (
            <>
              <p className="demo-clock" data-phase={player.isPlaying ? 'work' : 'break'}>
                {mmss(displayPosition(player))}
              </p>
              <div className="demo-chips">
                <Lozenge tone="neutral">
                  videoId: {player.videoId ? `'${player.videoId}'` : 'null'}
                </Lozenge>
                <Lozenge tone={player.isPlaying ? 'success' : 'neutral'} dot={player.isPlaying}>
                  {player.isPlaying ? 'playing' : 'stopped'}
                </Lozenge>
                <Lozenge tone="neutral">title: {player.title ?? '(unresolved)'}</Lozenge>
              </div>
              <HStack gap="sm" wrap>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() =>
                    send({ type: 'load-video', videoId: VIDEOS[0].id, provider: 'youtube' })
                  }
                >
                  load-video
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!player.videoId}
                  onClick={() =>
                    send({ type: 'seek', position: Math.round(displayPosition(player)) + 30 })
                  }
                >
                  seek +30s
                </Button>
                {VIDEOS.map((v) => (
                  <Button
                    key={v.id}
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      // addedBy は載せない。誰が積んだかはホストが接続から埋める
                      // （クライアントに名乗らせると maxPerUser を回避できてしまう）。
                      send({
                        type: 'queue-add',
                        videoId: v.id,
                        provider: 'youtube',
                        maxPerUser: 1,
                      })
                    }
                  >
                    queue-add: {v.label}
                  </Button>
                ))}
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => send({ type: 'queue-play-next' })}
                >
                  queue-play-next
                </Button>
              </HStack>
              <p className="demo-label">queue (received by this client)</p>
              <p className="demo-readout">
                {player.queue.length === 0
                  ? '(empty)'
                  : player.queue
                      .map((q) => `${q.uid}  ${q.title ?? '(unresolved)'}  by ${q.addedBy ?? '—'}`)
                      .join('\n')}
              </p>
              {player.notice ? <p className="demo-readout">{player.notice}</p> : null}
            </>
          )}
        </div>

        {/* ── チャット。plugin ではなく core なので、extension-chat の broadcast が
             そのまま space-state の受信 case に噛み合う。 */}
        <div className="space-chatpane">
          <p className="demo-label">chat ({acting}'s view)</p>
          {state.pinnedMessage ? (
            <div style={{ marginBottom: '0.6rem' }}>
              <Lozenge tone="success" dot>
                pinned: #{state.pinnedMessage.id} {state.pinnedMessage.name}
              </Lozenge>
            </div>
          ) : null}
          <div className="space-log">
            {state.chatLines.length === 0 ? (
              <p className="demo-readout">(nothing yet)</p>
            ) : (
              <pre className="demo-readout">
                {state.chatLines
                  .slice(-10)
                  .map((line: any) =>
                    line.kind === 'log'
                      ? `— ${line.by} ${line.text}`
                      : `${line.self ? '›' : ' '} ${line.name}${line.id ? `#${line.id}` : '#?'}: ${
                          line.imageUrl ? '[sticker]' : line.text
                        }${
                          Object.keys(line.reactions ?? {}).length > 0
                            ? `  ${Object.entries(
                                line.reactions as Record<string, { count: number }>,
                              )
                                .map(([emoji, r]) => `${emoji}${r.count}`)
                                .join(' ')}`
                            : ''
                        }`,
                  )
                  .join('\n')}
              </pre>
            )}
          </div>
          <HStack gap="sm" wrap>
            <Button
              size="sm"
              variant="primary"
              onClick={() => store.chat.send(`hello from ${acting}`)}
            >
              send text
            </Button>
            {/* ⚠ 他所URLのスタンプ（allowlist に落ちる側）はこのページに置かないこと。
                store.chat.sendSticker() は本文を持たないメッセージを送るので、host が
                stickerAllowed: false を畳むと reduce は「テキストに落とす」のではなく null を
                返して丸ごと捨てる（落とせる本文が無いため）。結果、送信者の楽観的ローカル行
                だけが id 無しで残り、SDK の不具合のように見える。落ちたときにテキストへ
                フォールバックする挙動は、本文付きで送れる /examples/chat が正しく見せている。 */}
            <Button
              size="sm"
              variant="secondary"
              onClick={() => store.chat.sendSticker(OWN_STICKER)}
            >
              sticker (own URL)
            </Button>
            <Button size="sm" variant="secondary" onClick={() => store.chat.typing()}>
              typing
            </Button>
          </HStack>
          <HStack gap="sm" wrap style={{ marginTop: '0.5rem' }}>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                const last = [...state.chatLines].reverse().find((l: any) => l.id);
                if (last) store.chat.react(last.id, '🔥');
              }}
            >
              react 🔥
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                const last = [...state.chatLines].reverse().find((l: any) => l.id);
                if (last) store.chat.pin(last.id);
              }}
            >
              pin last
            </Button>
            <Button size="sm" variant="secondary" onClick={() => store.chat.pin(null)}>
              unpin
            </Button>
          </HStack>
        </div>
      </div>

      {/* ── ホスト。パッケージが返した記述子と、ホストが実際にやったことが並ぶ。 */}
      <div className="demo-pane">
        <p className="demo-label">host (this page plays the server)</p>
        <TraceList
          entries={trace}
          empty="Trigger an action to see reduce calls and effects appear here."
        />
      </div>
    </div>
  );
}
