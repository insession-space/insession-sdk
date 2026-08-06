// SpaceStore を React に繋ぐときの実動作デモ。
//
// ⚠ bail out の挙動を再実装しないこと。useSyncExternalStore（use-space-state.ts の1行の
// フック）にそのまま任せる。
//
// 繋ぎ込みは1行しかないので、コードを見せるだけでは「本当にこれだけ？」で終わってしまう。
// 代わりにレンダリング回数を出す — 同じ人の typing を連打しても2回目以降は再レンダリング
// されない。store が同一参照を返し useSyncExternalStore が bail out するからで、これは
// store が契約を正しく満たしている証拠になる。
//
// ⚠ レンダリング回数は ChatPanel 自身の中で数え、memo で包むこと。親から数えようとすると、
// 親の再レンダリング（トレースの更新）でも子が描き直されて回数が水増しされるうえ、
// 「数えた結果を親の state に書く → 親が再描画 → 子も再描画」で無限ループになる。

import { Button, Lozenge } from '@insession/design-system';
import { createSpaceStore, type SpaceStore } from '@insession/space-state';
import { memo, useRef, useState } from 'react';
import { pushEntry, type TraceEntry, TraceList } from './Trace.tsx';
import { useSpaceState } from './use-space-state.ts';

function createDemoStore(): SpaceStore {
  return createSpaceStore({
    selfName: 'you',
    t: (key) => `<${key}>`,
    getPresence: () => 'active',
  });
}

/**
 * store を購読するだけのコンポーネント。フックはこの1つで、ロジックは持たない。
 * memo で包んであるので、親が再描画されても props（store）が同じ限り描き直されない
 * — つまり下の renders は「store 由来の再レンダリング回数」だけを数える。
 */
const ChatPanel = memo(function ChatPanel({ store }: { store: SpaceStore }) {
  const state = useSpaceState(store);
  const renders = useRef(0);
  renders.current += 1;

  const lines = state.chatLines.slice(-4);
  return (
    <>
      <div className="demo-chips">
        <Lozenge tone="success" dot>
          {`<ChatPanel /> renders: ${renders.current}`}
        </Lozenge>
      </div>
      <pre className="demo-readout">
        {lines.length === 0 ? (
          <span className="k">{'  (no messages yet)\n'}</span>
        ) : (
          // 同じ文面が並びうるので、1要素にまとめて改行で並べる（key を捻り出さない）。
          <span className="v">
            {`${lines
              .map(
                (line: Record<string, unknown>) => `  ${String(line.name)}: ${String(line.text)}`,
              )
              .join('\n')}\n`}
          </span>
        )}
        <span className="k">
          {state.typingUsers.length > 0 ? `  ${state.typingUsers.join(', ')} is typing…` : '  —'}
        </span>
      </pre>
    </>
  );
});

export default function ReactBindingDemo() {
  const storeRef = useRef<SpaceStore | null>(null);
  if (storeRef.current === null) storeRef.current = createDemoStore();
  const store = storeRef.current;

  const [received, setReceived] = useState(0);
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  const [chatSeq, setChatSeq] = useState(0);
  // reset で ChatPanel を作り直すための key。
  const [generation, setGeneration] = useState(0);

  function receive(msg: Record<string, unknown>, call: string) {
    const before = store.getState();
    store.receive(msg);
    const rerendered = store.getState() !== before;
    setReceived((n) => n + 1);
    setTrace((t) =>
      pushEntry(t, {
        call,
        ret: rerendered
          ? 'getState() returned a new reference → re-render'
          : 'getState() returned the same reference → bail out, no re-render',
        noop: !rerendered,
      }),
    );
  }

  function sendChat() {
    const next = chatSeq + 1;
    setChatSeq(next);
    const text = `let's go #${next}`;
    receive(
      { type: 'chat', name: 'ren', text },
      `store.receive({ type: 'chat', name: 'ren', text: '${text}' })`,
    );
  }

  function sendTyping() {
    receive({ type: 'typing', name: 'ren' }, "store.receive({ type: 'typing', name: 'ren' })");
  }

  function reset() {
    storeRef.current = createDemoStore();
    setReceived(0);
    setTrace([]);
    setChatSeq(0);
    setGeneration((n) => n + 1);
  }

  return (
    <div className="demo not-content">
      <div className="demo-bar">
        <span>@insession/space-state → React</span>
        <span className="demo-api">useSyncExternalStore</span>
      </div>
      <div className="demo-body">
        <div className="demo-pane">
          <p className="demo-label">Feed an inbound message</p>
          <div className="demo-controls">
            <Button variant="primary" size="sm" onClick={sendChat}>
              chat
            </Button>
            <Button variant="secondary" size="sm" onClick={sendTyping}>
              typing (same person)
            </Button>
            <Button variant="secondary" size="sm" onClick={reset}>
              reset
            </Button>
          </div>

          <div className="demo-chips" style={{ marginTop: '1.1rem' }}>
            <Lozenge tone="neutral">{`messages received: ${received}`}</Lozenge>
          </div>

          <p className="demo-label">{'<ChatPanel /> output'}</p>
          <ChatPanel key={generation} store={store} />
        </div>

        <div className="demo-pane">
          <p className="demo-label">What happened</p>
          <TraceList entries={trace} empty="Nothing received yet." />
        </div>
      </div>
    </div>
  );
}
