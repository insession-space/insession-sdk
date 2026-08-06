// @insession/extension-pomodoro の実動作デモ。
//
// ⚠ 挙動を再実装しないこと。ここは npm に出ているパッケージそのものを import して動かす。
// デモが独自の状態機械を持つと、パッケージを直したときにデモだけ古くなる。
//
// このデモで見せたいのは「動作中の state は秒を持たない」こと。時計は endsAt から
// クライアントが毎秒描き直すが、state 自体は操作したときとフェーズが切れたときしか変わらない。
//
// ⚠ setState の updater の中で setTrace を呼ばないこと。updater は React に二度呼ばれうるので
// （StrictMode の二重呼び出し）、トレースが重複して積まれる。state は素直に読んで使う。

import { Button, HStack, Input, Lozenge } from '@insession/design-system';
import {
  defaultState,
  onTimer,
  type PomodoroState,
  reduce,
  timerDelay,
} from '@insession/extension-pomodoro';
import { useEffect, useState } from 'react';
import { pushEntry, type TraceEntry, TraceList } from './Trace.tsx';

function mmss(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** 表示用の残り秒。動作中は endsAt から引く（state は秒を持たない）。 */
function secondsLeft(state: PomodoroState): number {
  if (!state.running || state.endsAt === null) return state.remaining;
  return Math.max(0, Math.round((state.endsAt - Date.now()) / 1000));
}

function summarize(state: PomodoroState): string {
  return `{ running: ${state.running}, phase: '${state.phase}', cycles: ${state.cycles} }`;
}

export default function PomodoroDemo() {
  const [state, setState] = useState<PomodoroState>(() => defaultState());
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  const [workMinutes, setWorkMinutes] = useState('25');
  // 時計の再描画専用。state ではなく「今が何時か」が進んだことを表すだけ。
  const [, setTick] = useState(0);

  function dispatch(action: string, payload?: Record<string, unknown>) {
    const call = payload
      ? `reduce(state, '${action}', ${JSON.stringify(payload)})`
      : `reduce(state, '${action}')`;
    const result = reduce(state, action, payload);
    if (result === null) {
      // null は「無効・no-op なので無視する」。握り潰さずそのまま見せる。
      setTrace((t) =>
        pushEntry(t, { call, ret: 'null — invalid or a no-op, ignore it', noop: true }),
      );
      return;
    }
    // reduce は { state, effects } を返す。このデモは宣言の永続化（effects の
    // 中身）までは扱わないので state だけ取る。
    const next = result.state;
    const delay = timerDelay(next);
    setState(next);
    setTrace((t) =>
      pushEntry(t, {
        call,
        ret: summarize(next),
        effects: [
          `timerDelay(state) → ${delay === null ? 'null (not running)' : `${Math.round(delay / 1000)}s`}`,
        ],
      }),
    );
  }

  // フェーズの切り替わりは timerDelay で予約する（README の schedulePhaseTimer と同じ形）。
  useEffect(() => {
    const delay = timerDelay(state);
    if (delay === null) return;
    const id = setTimeout(() => {
      const next = onTimer(state).state;
      setState(next);
      setTrace((t) =>
        pushEntry(t, { call: 'timerDelay elapsed → onTimer(state)', ret: summarize(next) }),
      );
    }, delay);
    return () => clearTimeout(id);
  }, [state]);

  // 時計だけを描き直す。state は触らない — ここがこのパッケージの要点。
  useEffect(() => {
    if (!state.running) return;
    const id = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [state.running]);

  return (
    <div className="demo not-content">
      <div className="demo-bar">
        <span>@insession/extension-pomodoro</span>
        <span className="demo-api">reduce / timerDelay / onTimer</span>
      </div>
      <div className="demo-body">
        <div className="demo-pane">
          <p className="demo-label">Timer</p>
          {/* ⚠ DS の `RingTimer` はここでは使わない。あれは `secondsLeft` を **生の秒数のまま**
              描画する（`Math.round(secondsLeft)` をそのまま出す）ので、25分のフェーズが
              `25:00` ではなく `1500` と出てしまう。既定の `urgentThreshold` が 10 秒なことからも
              分かるとおり、短いカウントダウン向けの部品で、分単位のタイマーは想定外。
              `ariaLabel` を省くと既定の読み上げ文が日本語になる問題もある（このデモは英語ページと
              共有）。mm:ss の表示はこのページの主題（「実行中のタイマーは秒を持たない」）そのものなので、
              自前の表示を残す。WatchPartyDemo も同じ理由で `demo-clock` を維持している。 */}
          <p className="demo-clock" data-phase={state.phase}>
            {mmss(secondsLeft(state))}
          </p>
          <div className="demo-chips">
            <Lozenge tone="neutral">phase: {state.phase}</Lozenge>
            <Lozenge tone={state.running ? 'success' : 'neutral'} dot={state.running}>
              {state.running ? 'running' : 'stopped'}
            </Lozenge>
            <Lozenge tone="neutral">cycles: {state.cycles}</Lozenge>
          </div>

          <HStack gap="sm" wrap>
            <Button
              size="sm"
              variant={state.running ? 'secondary' : 'primary'}
              onClick={() => dispatch('start')}
            >
              start
            </Button>
            <Button size="sm" variant="secondary" onClick={() => dispatch('pause')}>
              pause
            </Button>
            <Button size="sm" variant="secondary" onClick={() => dispatch('skip')}>
              skip
            </Button>
            <Button size="sm" variant="secondary" onClick={() => dispatch('reset')}>
              reset
            </Button>
          </HStack>

          <HStack gap="sm" align="end">
            <Input
              id="pomodoro-work"
              label="configure — work"
              type="number"
              min={1}
              max={120}
              value={workMinutes}
              onChange={(e) => setWorkMinutes(e.target.value)}
            />
            <span>min</span>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => dispatch('configure', { workMinutes: Number(workMinutes) })}
            >
              send
            </Button>
          </HStack>

          <p className="demo-label">state</p>
          <pre className="demo-readout">
            <span className="k">running: </span>
            <span className="v">{String(state.running)}</span>
            {'\n'}
            <span className="k">phase: </span>
            <span className="v">'{state.phase}'</span>
            {'\n'}
            <span className="k">endsAt: </span>
            <span className="n">{state.endsAt === null ? 'null' : state.endsAt}</span>
            {'\n'}
            <span className="k">remaining: </span>
            <span className="n">{state.remaining}</span>
            {'\n'}
            <span className="k">config: </span>
            <span className="v">
              {`{ work: ${state.config.work}, break: ${state.config.break} }`}
            </span>
            {'\n'}
            <span className="k">cycles: </span>
            <span className="n">{state.cycles}</span>
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
