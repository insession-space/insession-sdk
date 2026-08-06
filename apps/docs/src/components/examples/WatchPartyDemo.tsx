// @insession/extension-watch-party の実動作デモ。
//
// ⚠ 挙動を再実装しないこと。ここは npm に出ているパッケージそのものを import して動かす。
// デモが独自の状態機械を持つと、パッケージを直したときにデモだけ古くなる。
//
// このパッケージが他の4つと違う核は「reduce が { state, effects } を返し、
// host が effects を実行する」という effect 記述子の設計。このデモで見せたい5点:
//  (a) effects が state と並んで見える（broadcast / send-to-sender / persist-* /
//      resolve-metadata が呼び出しのたびにどう出るか）
//  (b) resolve-metadata の往復（queue-add でタイトル未解決のまま積まれ、host が
//      解決した体で reduce(state, 'resolve-metadata', ...) を呼ぶとタイトルが埋まる）
//  (c) 位置がウォールクロック外挿であること（state は秒を持たず、currentPosition が
//      毎秒描き直す。play してから state は変わらないが時計だけ進む）
//  (d) 拒否が送信者にだけ返る（maxPerUser を超えた queue-add は send-to-sender の
//      queue-rejected になる）
//  (e) pause が no-op であること（設計上、常に null）
//
// ⚠ setState の updater の中で setTrace を呼ばないこと。updater は React に二度呼ばれうるので
// （StrictMode の二重呼び出し）、トレースが重複して積まれる。state は素直に読んで使う。

import {
  createWatchParty,
  type WatchPartyEffect,
  type WatchPartyPayload,
  type WatchPartyState,
  type WatchPartyStateApi,
} from '@insession/extension-watch-party';
import { useEffect, useState } from 'react';
import { pushEntry, type TraceEntry, TraceList } from './Trace.tsx';

// 11文字の英数字/ハイフン/アンダースコアでないと VIDEO_ID_RE に弾かれる。実在の動画IDを流用。
const VIDEOS = [
  { id: 'dQw4w9WgXcQ', label: 'Video A' },
  { id: 'jNQXAC9IVRw', label: 'Video B' },
] as const;

const MEMBERS = ['Alice', 'Bob'] as const;

function mmss(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function summarize(state: WatchPartyState): string {
  return `{ videoId: ${state.videoId ? `'${state.videoId}'` : 'null'}, isPlaying: ${state.isPlaying}, queue: ${state.queue.length}, history: ${state.history.length} }`;
}

/** 1 effect を1行に要約する。トレースの「副作用」欄はこれの配列。 */
function describeEffect(e: WatchPartyEffect): string {
  switch (e.type) {
    case 'broadcast': {
      const msg = e.message as { type?: string };
      return `broadcast${e.excludeSender ? ' (excludeSender)' : ''} → { type: '${msg?.type}' }`;
    }
    case 'send-to-sender': {
      const msg = e.message as { type?: string; reason?: string; limit?: number };
      const reason = msg?.reason ? `, reason: '${msg.reason}'` : '';
      const limit = msg?.limit !== undefined ? `, limit: ${msg.limit}` : '';
      return `send-to-sender → { type: '${msg?.type}'${reason}${limit} }`;
    }
    case 'persist-playback':
      return `persist-playback → { videoId: ${e.videoId ? `'${e.videoId}'` : 'null'}, isPlaying: ${e.isPlaying}, position: ${Math.round(e.position)} }`;
    case 'persist-media':
      return `persist-media → { provider: ${e.provider ? `'${e.provider}'` : 'null'} }`;
    case 'resolve-metadata':
      return `resolve-metadata → { uid: '${e.uid}', kind: '${e.kind}', videoId: '${e.videoId}' } — host must fetch title/duration`;
    default:
      return String((e as { type: string }).type);
  }
}

export default function WatchPartyDemo() {
  // ファクトリはコンポーネントの外では作れないため（このデモは shuffle を使わないが、
  // 他デモの流儀に揃えて useState の初期化関数で1回だけ作る）。
  const [wp] = useState<WatchPartyStateApi>(() => createWatchParty({}));
  const [state, setState] = useState<WatchPartyState>(() => wp.defaultState());
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  const [asMember, setAsMember] = useState<(typeof MEMBERS)[number]>('Alice');
  // 時計の再描画専用。state ではなく「今が何時か」が進んだことを表すだけ。
  const [, setTick] = useState(0);

  function dispatch(action: string, payload?: WatchPartyPayload) {
    const call = payload
      ? `reduce(state, '${action}', ${JSON.stringify(payload)})`
      : `reduce(state, '${action}')`;
    const out = wp.reduce(state, action, payload);
    if (!out) {
      // null は「無効・no-op なので無視する」。握り潰さずそのまま見せる。
      setTrace((t) =>
        pushEntry(t, { call, ret: 'null — invalid or a no-op, ignore it', noop: true }),
      );
      return;
    }
    setState(out.state);
    setTrace((t) =>
      pushEntry(t, { call, ret: summarize(out.state), effects: out.effects.map(describeEffect) }),
    );
  }

  // 時計だけを描き直す。state は触らない — これがこのパッケージの要点(c)。
  useEffect(() => {
    if (!state.isPlaying) return;
    const id = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [state.isPlaying]);

  const position = wp.currentPosition(state);

  return (
    <div className="demo not-content">
      <div className="demo-bar">
        <span>@insession/extension-watch-party</span>
        <span className="demo-api">createWatchParty / reduce / currentPosition</span>
      </div>
      <div className="demo-body">
        <div className="demo-pane">
          <p className="demo-label">acting as</p>
          <div className="demo-controls">
            {MEMBERS.map((m) => (
              <button
                key={m}
                type="button"
                className="demo-btn"
                data-primary={asMember === m ? '' : undefined}
                onClick={() => setAsMember(m)}
              >
                as {m}
              </button>
            ))}
          </div>

          <p className="demo-label">Now playing</p>
          <p className="demo-clock" data-phase={state.isPlaying ? 'work' : 'break'}>
            {mmss(position)}
          </p>
          <div className="demo-chips">
            <span className="demo-chip">
              videoId: {state.videoId ? `'${state.videoId}'` : 'null'}
            </span>
            <span className="demo-chip" data-on={state.isPlaying ? '' : undefined}>
              {state.isPlaying ? 'playing' : 'stopped'}
            </span>
          </div>
          <div className="demo-controls">
            <button
              type="button"
              className="demo-btn"
              onClick={() =>
                dispatch('load-video', { videoId: VIDEOS[0].id, provider: 'youtube', by: asMember })
              }
            >
              load-video
            </button>
            <button
              type="button"
              className="demo-btn"
              data-primary=""
              disabled={!state.videoId}
              onClick={() => dispatch('play', { by: asMember })}
            >
              play
            </button>
            <button
              type="button"
              className="demo-btn"
              disabled={!state.videoId}
              onClick={() => dispatch('seek', { position: position + 30, by: asMember })}
            >
              seek +30s
            </button>
            <button type="button" className="demo-btn" onClick={() => dispatch('pause')}>
              pause
            </button>
            <button
              type="button"
              className="demo-btn"
              disabled={!state.videoId}
              onClick={() => dispatch('video-ended', { videoId: state.videoId ?? '' })}
            >
              video-ended
            </button>
          </div>

          <p className="demo-label">Queue (max 1 per member — try adding twice)</p>
          <div className="demo-controls">
            {VIDEOS.map((v) => (
              <button
                key={v.id}
                type="button"
                className="demo-btn"
                onClick={() =>
                  dispatch('queue-add', {
                    videoId: v.id,
                    provider: 'youtube',
                    addedBy: asMember,
                    addedByUid: asMember,
                    maxPerUser: 1,
                  })
                }
              >
                queue-add: {v.label}
              </button>
            ))}
            <button
              type="button"
              className="demo-btn"
              onClick={() => dispatch('queue-play-next', { by: asMember })}
            >
              queue-play-next
            </button>
          </div>

          {state.queue.length === 0 ? (
            <p className="demo-chip" style={{ marginTop: '0.6rem', display: 'inline-block' }}>
              queue is empty
            </p>
          ) : (
            <div
              className="demo-controls"
              style={{ flexDirection: 'column', alignItems: 'stretch' }}
            >
              {state.queue.map((q) => (
                <div key={q.uid} className="demo-controls">
                  <span className="demo-chip">
                    {q.uid}: {q.title ?? '(未解決 — resolve-metadata 待ち)'}
                  </span>
                  {q.title === null && (
                    <button
                      type="button"
                      className="demo-btn"
                      onClick={() =>
                        dispatch('resolve-metadata', {
                          uid: q.uid,
                          kind: 'queue',
                          title: `Resolved: ${q.videoId}`,
                          durationSec: 180,
                        })
                      }
                    >
                      ホストがメタデータを解決
                    </button>
                  )}
                  <button
                    type="button"
                    className="demo-btn"
                    onClick={() => dispatch('queue-remove', { uid: q.uid })}
                  >
                    queue-remove
                  </button>
                </div>
              ))}
            </div>
          )}

          <p className="demo-label">state</p>
          <pre className="demo-readout">
            <span className="k">videoId: </span>
            <span className="v">{state.videoId ? `'${state.videoId}'` : 'null'}</span>
            {'\n'}
            <span className="k">isPlaying: </span>
            <span className="v">{String(state.isPlaying)}</span>
            {'\n'}
            <span className="k">currentPosition(state): </span>
            <span className="n">{Math.round(position)}</span>
            {'\n'}
            <span className="k">queue: </span>
            <span className="n">{state.queue.length}</span>
            {'\n'}
            <span className="k">history: </span>
            <span className="n">{state.history.length}</span>
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
