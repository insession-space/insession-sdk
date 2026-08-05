// @insession/space-state の実動作デモ。
//
// ⚠ 挙動を再実装しないこと。createSpaceStore をそのまま使う。
//
// 見せたいのは「effect は記述子として返るだけで、実行されない」こと。onEffect に届いた
// ものをそのまま右のペインに出す — 音も鳴らないし通知も出ない、ただのデータであることが
// 一目で分かる。

import { createSpaceStore, type SpaceEffect, type SpaceStore } from '@insession/space-state';
import { useEffect, useRef, useState } from 'react';
import { pushEntry, type TraceEntry, TraceList } from './Trace.tsx';

const NAMES = ['haruka', 'ren', 'mei'];

function createDemoStore(): SpaceStore {
  return createSpaceStore({
    selfName: 'you',
    // 任意の文言解決関数。i18n の t をそのまま渡せる。デモでは印を付けて返すだけ。
    t: (key) => `<${key}>`,
    getPresence: () => 'active',
  });
}

/** state の要約。SpaceState は広いので、このデモが触る3つだけ見せる。 */
type Snapshot = {
  members: string[];
  typingUsers: string[];
  chatLines: { kind: string; label: string }[];
};

function snapshot(store: SpaceStore): Snapshot {
  const state = store.getState();
  return {
    members: state.members.map((m: { name: string }) => m.name),
    typingUsers: state.typingUsers,
    chatLines: state.chatLines.map((line: Record<string, unknown>) => ({
      kind: String(line.kind),
      label:
        line.kind === 'log'
          ? `${String(line.by)} ${String(line.text)}`
          : `${String(line.name)}: ${String(line.text)}`,
    })),
  };
}

export default function SpaceStateDemo() {
  // store は1つだけ作って使い回す（毎レンダリングで作り直すと state が消える）。
  const storeRef = useRef<SpaceStore | null>(null);
  if (storeRef.current === null) storeRef.current = createDemoStore();
  const store = storeRef.current;

  const [view, setView] = useState<Snapshot>(() => snapshot(store));
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  const [chatSeq, setChatSeq] = useState(0);

  // このレンダリングサイクルで届いた effect を集めるための箱。onEffect は receive() の
  // 内側で同期的に呼ばれるので、receive を挟んで前後で読めば「その受信が出した effect」が取れる。
  const inbox = useRef<SpaceEffect[]>([]);
  useEffect(() => {
    const unsubscribe = store.onEffect((effect) => {
      inbox.current.push(effect);
    });
    // ⚠ unsubscribe をそのまま返さないこと。Set.delete が返す boolean は
    // useEffect の cleanup（void を要求する）に代入できず astro check が落ちる。
    return () => {
      unsubscribe();
    };
  }, [store]);

  function receive(msg: Record<string, unknown>, call: string) {
    inbox.current = [];
    const before = store.getState();
    store.receive(msg);
    const after = store.getState();
    const effects = inbox.current.map((e) => JSON.stringify(e));
    setTrace((t) =>
      pushEntry(t, {
        call,
        // 同一参照で返るのは意図的な最適化。ここを見せたいので明示する。
        ret:
          after === before
            ? 'getState() returned the same reference — no re-render'
            : 'state updated',
        noop: after === before,
        effects: effects.length > 0 ? effects : ['(no effects)'],
      }),
    );
    setView(snapshot(store));
  }

  function joinNext() {
    // サーバーは入室者を含む members 全体を毎回配るので、デモでもその形で渡す。
    const prev = view.members.map((name, i) => ({ id: i + 1, name }));
    const member = { id: prev.length + 1, name: NAMES[prev.length] };
    receive(
      { type: 'member-joined', member, members: [...prev, member] },
      `store.receive({ type: 'member-joined', member: { name: '${member.name}' } })`,
    );
  }

  function sendChat() {
    const name = view.members[0] ?? 'haruka';
    const next = chatSeq + 1;
    setChatSeq(next);
    const text = `good morning #${next}`;
    receive(
      { type: 'chat', name, text },
      `store.receive({ type: 'chat', name: '${name}', text: '${text}' })`,
    );
  }

  function sendTyping() {
    const name = view.members[0] ?? 'haruka';
    receive({ type: 'typing', name }, `store.receive({ type: 'typing', name: '${name}' })`);
  }

  function reset() {
    storeRef.current = createDemoStore();
    setView(snapshot(storeRef.current));
    setTrace([]);
    setChatSeq(0);
  }

  return (
    <div className="demo not-content">
      <div className="demo-bar">
        <span>@insession/space-state</span>
        <span className="demo-api">createSpaceStore / receive / onEffect</span>
      </div>
      <div className="demo-body">
        <div className="demo-pane">
          <p className="demo-label">Feed an inbound message</p>
          <div className="demo-controls">
            <button
              type="button"
              className="demo-btn"
              data-primary=""
              onClick={joinNext}
              disabled={view.members.length >= NAMES.length}
            >
              member-joined
            </button>
            <button type="button" className="demo-btn" onClick={sendChat}>
              chat
            </button>
            <button type="button" className="demo-btn" onClick={sendTyping}>
              typing
            </button>
            <button type="button" className="demo-btn" onClick={reset}>
              reset
            </button>
          </div>

          <p className="demo-label">store.getState()</p>
          <pre className="demo-readout">
            <span className="k">members: </span>
            <span className="v">[{view.members.join(', ')}]</span>
            {'\n'}
            <span className="k">typingUsers: </span>
            <span className="v">[{view.typingUsers.join(', ')}]</span>
            {'\n'}
            <span className="k">chatLines: </span>
            <span className="n">{view.chatLines.length}</span>
            {/* 同じ文面の行が並びうるので、1要素にまとめて改行で並べる（key を捻り出さない）。 */}
            {view.chatLines.length > 0 ? (
              <span className="v">
                {`\n${view.chatLines
                  .slice(-4)
                  .map((line) => `  ${line.kind.padEnd(4)} ${line.label}`)
                  .join('\n')}`}
              </span>
            ) : null}
          </pre>
        </div>

        <div className="demo-pane">
          <p className="demo-label">Effects handed to onEffect</p>
          <TraceList entries={trace} empty="Nothing received yet." />
        </div>
      </div>
    </div>
  );
}
