// @insession/extension-whiteboard の実動作デモ。
//
// ⚠ 挙動を再実装しないこと。ここは npm に出ているパッケージそのものを import して動かす。
// デモが独自の状態機械を持つと、パッケージを直したときにデモだけ古くなる。
//
// このデモで見せたい3点:
//  (a) ファクトリと isOwnImageUrl の注入 — 自前ストレージの URL だけが submit-drawing を
//      通り、他所の URL は null（拒否）になる。
//  (b) reduce が null を返す no-op — 握り潰さずトレースに出す（set-mode は常に no-op、
//      何も足さない erase も no-op）。
//  (c) 伝言ゲーム（relay）のフェーズ機械 — state は秒を持たず、timerDelay / onTimer で進む。
//
// ⚠ setState の updater の中で setTrace を呼ばないこと。updater は React に二度呼ばれうるので
// （StrictMode の二重呼び出し）、トレースが重複して積まれる。state は素直に読んで使う。

import { Button, HStack, Lozenge, SegmentedControl } from '@insession/design-system';
import {
  createWhiteboardState,
  type WhiteboardState,
  type WhiteboardStateApi,
} from '@insession/extension-whiteboard';
import { useEffect, useRef, useState } from 'react';
import { pushEntry, type TraceEntry, TraceList } from './Trace.tsx';

// このデモだけの値。「自前ストレージの URL」を isOwnImageUrl がどう判定するかを見せるための
// プレフィックスで、パッケージ側は一切知らない（host が決めるもの、というのがこの package の核）。
const OWN_PREFIX = 'https://cdn.example.com/uploads/';
const OTHER_URL = 'https://evil.example.invalid/stolen.png';

const PLAYERS = ['Alice', 'Bob', 'Carol'] as const;

function summarize(state: WhiteboardState): string {
  const game = state.game
    ? `{ phase: '${state.game.phase}', round: ${state.game.round}/${state.game.totalRounds} }`
    : 'null';
  return `{ strokes: ${state.strokes.length}, shapes: ${state.shapes.length}, game: ${game} }`;
}

/** 表示用の残り秒。relay のフェーズも state は秒を持たず endsAt から引く。 */
function secondsLeft(state: WhiteboardState): number | null {
  const endsAt = state.game?.endsAt;
  if (!endsAt) return null;
  return Math.max(0, Math.round((endsAt - Date.now()) / 1000));
}

export default function WhiteboardDemo() {
  // ファクトリはコンポーネントの外では作れない（isOwnImageUrl はデモのクロージャ）ので、
  // useState の初期化関数で1回だけ作る。毎レンダリング作り直さない。
  const [wb] = useState<WhiteboardStateApi>(() =>
    createWhiteboardState({ isOwnImageUrl: (url) => url.startsWith(OWN_PREFIX) }),
  );
  const [state, setState] = useState<WhiteboardState>(() => wb.defaultState());
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  const [view, setView] = useState<'free' | 'relay'>('free');
  const [asPlayer, setAsPlayer] = useState<(typeof PLAYERS)[number]>('Alice');
  const idCounter = useRef(0);
  // 時計の再描画専用。state ではなく「今が何時か」が進んだことを表すだけ。
  const [, setTick] = useState(0);

  function nextId(prefix: string): string {
    idCounter.current += 1;
    return `${prefix}-${idCounter.current}`;
  }

  function dispatch(action: string, payload?: Record<string, unknown>) {
    const call = payload
      ? `reduce(state, '${action}', ${JSON.stringify(payload)})`
      : `reduce(state, '${action}')`;
    const result = wb.reduce(state, action, payload);
    if (result === null) {
      // null は「無効・no-op なので無視する」。握り潰さずそのまま見せる。
      setTrace((t) =>
        pushEntry(t, { call, ret: 'null — invalid or a no-op, ignore it', noop: true }),
      );
      return;
    }
    // reduce は { state, effects } か、状態を変えない { effects }（ライブ中継）を
    // 返す。このデモは中継も履歴の永続化も扱わないので、state があるときだけ進める。
    if (!('state' in result)) return;
    const next = result.state;
    const delay = wb.timerDelay(next);
    setState(next);
    setTrace((t) =>
      pushEntry(t, {
        call,
        ret: summarize(next),
        effects: [
          `timerDelay(state) → ${delay === null ? 'null (no relay phase running)' : `${Math.round(delay / 1000)}s`}`,
        ],
      }),
    );
  }

  // relay のフェーズ切り替えは timerDelay で予約する（README の scheduleRelayTimer と同じ形）。
  useEffect(() => {
    const delay = wb.timerDelay(state);
    if (delay === null) return;
    const id = setTimeout(() => {
      const fired = wb.onTimer(state);
      if (!fired || !('state' in fired)) return;
      const next = fired.state;
      setState(next);
      setTrace((t) =>
        pushEntry(t, { call: 'timerDelay elapsed → onTimer(state)', ret: summarize(next) }),
      );
    }, delay);
    return () => clearTimeout(id);
  }, [state, wb]);

  // 時計だけを描き直す。state は触らない。
  useEffect(() => {
    if (!state.game?.endsAt) return;
    const id = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [state.game?.endsAt]);

  const remaining = secondsLeft(state);
  const game = state.game;

  return (
    <div className="demo not-content">
      <div className="demo-bar">
        <span>@insession/extension-whiteboard</span>
        <span className="demo-api">createWhiteboardState / reduce / timerDelay / onTimer</span>
      </div>
      <div className="demo-body">
        <div className="demo-pane">
          <p className="demo-label">Mode</p>
          <SegmentedControl
            ariaLabel="Mode"
            items={[
              { value: 'free', label: 'free' },
              { value: 'relay', label: 'relay' },
            ]}
            value={view}
            onValueChange={(v) => {
              setView(v as 'free' | 'relay');
              // set-mode は README のとおり常に no-op（互換のためだけに受け付ける）。タブの
              // 切り替え自体はローカルの UI state で行い、これは no-op を毎回見せるための呼び出し。
              dispatch('set-mode');
            }}
          />

          {view === 'free' ? (
            <>
              <div className="demo-chips" style={{ marginTop: '0.9rem' }}>
                <Lozenge tone="neutral">strokes: {state.strokes.length}</Lozenge>
                <Lozenge tone="neutral">shapes: {state.shapes.length}</Lozenge>
              </div>
              <HStack gap="sm" wrap>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    dispatch('add-stroke', {
                      stroke: {
                        id: nextId('stroke'),
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
                    dispatch('add-shape', {
                      shape: {
                        id: nextId('shape'),
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
                  onClick={() => dispatch('erase', { ids: state.strokes.map((s) => s.id) })}
                >
                  erase
                </Button>
                <Button size="sm" variant="secondary" onClick={() => dispatch('clear')}>
                  clear
                </Button>
              </HStack>
            </>
          ) : (
            <>
              <div className="demo-chips" style={{ marginTop: '0.9rem' }}>
                <Lozenge tone="neutral">phase: {game?.phase ?? 'no game'}</Lozenge>
                {game && game.phase !== 'lobby' && game.phase !== 'album' ? (
                  <Lozenge tone="success" dot>
                    {remaining ?? 0}s left
                  </Lozenge>
                ) : null}
                <Lozenge tone="neutral">
                  timerDelay: {(() => {
                    const d = wb.timerDelay(state);
                    return d === null ? 'null' : `${Math.round(d / 1000)}s`;
                  })()}
                </Lozenge>
              </div>

              {(!game || game.phase === 'lobby') && (
                <HStack gap="sm" wrap>
                  {PLAYERS.map((p) => (
                    <Button
                      key={p}
                      size="sm"
                      variant="secondary"
                      disabled={!!game?.players.includes(p)}
                      onClick={() => dispatch('join-game', { by: p })}
                    >
                      join: {p}
                    </Button>
                  ))}
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={!game || game.players.length < 2}
                    onClick={() => dispatch('start-game')}
                  >
                    start-game
                  </Button>
                </HStack>
              )}

              {game && game.phase !== 'lobby' && game.phase !== 'album' && (
                <>
                  <SegmentedControl
                    ariaLabel="Acting as"
                    items={game.players.map((p) => ({ value: p, label: `as ${p}` }))}
                    value={asPlayer}
                    onValueChange={(v) => setAsPlayer(v as (typeof PLAYERS)[number])}
                  />
                  <HStack gap="sm" wrap>
                    {game.phase === 'prompt' && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          dispatch('submit-prompt', { by: asPlayer, text: 'a cat riding a bike' })
                        }
                      >
                        submit prompt
                      </Button>
                    )}
                    {game.phase === 'draw' && (
                      <>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() =>
                            dispatch('submit-drawing', {
                              by: asPlayer,
                              imageUrl: `${OWN_PREFIX}${nextId('drawing')}.png`,
                            })
                          }
                        >
                          own URL
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() =>
                            dispatch('submit-drawing', { by: asPlayer, imageUrl: OTHER_URL })
                          }
                        >
                          other URL
                        </Button>
                      </>
                    )}
                    {game.phase === 'guess' && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => dispatch('submit-guess', { by: asPlayer, text: 'a cat' })}
                      >
                        submit guess
                      </Button>
                    )}
                  </HStack>
                </>
              )}

              {game?.phase === 'album' && (
                <HStack gap="sm" wrap>
                  <Button size="sm" variant="secondary" onClick={() => dispatch('reset-game')}>
                    reset-game
                  </Button>
                </HStack>
              )}
            </>
          )}

          <p className="demo-label">state</p>
          <pre className="demo-readout">
            <span className="k">mode: </span>
            <span className="v">'{state.mode}'</span>
            {'\n'}
            <span className="k">strokes: </span>
            <span className="n">{state.strokes.length}</span>
            {'\n'}
            <span className="k">shapes: </span>
            <span className="n">{state.shapes.length}</span>
            {'\n'}
            <span className="k">game: </span>
            <span className="v">{game ? summarize(state).split('game: ')[1] : 'null'}</span>
          </pre>
        </div>

        <div className="demo-pane">
          <p className="demo-label">Calls</p>
          <TraceList entries={trace} empty="Nothing has been called yet." />
        </div>
      </div>
    </div>
  );
}
