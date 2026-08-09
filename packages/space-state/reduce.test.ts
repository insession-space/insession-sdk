// reduceSpace の回帰テスト。主要な msg.type それぞれの畳み込みを固定する。
//
// extension 固有の振る舞いはここでは扱わない（各 extension パッケージのテストが持つ）。
// ここが見るのは extension に依存しない core の挙動だけ — PluginClient を1つも渡さなくても
// apps へ格納されること、渡したときに pluginLocal / lines / effects が反映されること。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resetConnection } from './actions.ts';
import type { PluginClient } from './plugin.ts';
import type { ReduceCtx } from './reduce.ts';
import { reduceSpace } from './reduce.ts';
import { initialSpaceState } from './state.ts';

function makeCtx(overrides: Partial<ReduceCtx> = {}): ReduceCtx {
  return {
    selfName: 'Alice',
    t: (key: string, ...args: any[]) => (args.length ? `${key}(${args.join(',')})` : key),
    now: 1000,
    presence: 'active',
    // settings 省略時のフォールバック既定値(store.ts が initialSettings から積む値。
    // テストでは特に既定値を検証したいケース以外は空で十分)。
    defaultSettings: {},
    ...overrides,
  };
}

describe('reduceSpace', () => {
  describe('space-state', () => {
    it('全状態を置換し、screenShareSharer は代入のみで発火しない', () => {
      const state = initialSpaceState();
      const msg = {
        type: 'space-state',
        selfId: 7,
        members: [{ id: 7, name: 'Alice' }],
        title: 'my space',
        pinnedMessage: null,
        owner: { id: 7, name: 'Alice' },
        kind: 'my_space',
        community: null,
        settings: undefined,
        communityId: null,
        features: { durationLimit: true },
        apps: { whiteboard: { shapes: [] } },
        screenShareSharer: { id: 9, name: 'Bob' },
      };
      const { state: next, effects } = reduceSpace(state, msg, makeCtx());
      assert.equal(next.connected, true);
      assert.equal(next.selfId, 7);
      assert.deepEqual(next.members, msg.members);
      assert.equal(next.title, 'my space');
      assert.equal(next.kind, 'my_space');
      assert.deepEqual(next.apps, msg.apps);
      assert.deepEqual(next.screenShareSharer, { id: 9, name: 'Bob' });
      // 音・通知系の effect は一切出ない(代入のみ)。
      assert.ok(!effects.some((e) => e.type === 'sound'));
      assert.ok(!effects.some((e) => e.type.startsWith('notify')));
      assert.ok(effects.some((e) => e.type === 'history-title' && e.title === 'my space'));
    });

    it('plugin(initLocal あり)を渡すと pluginLocal が初期化され、effect は1つも出ない', () => {
      const plugin: PluginClient = {
        id: 'demo',
        initLocal: (appState) => ({ seen: appState?.value ?? null }),
      };
      const state = initialSpaceState();
      const msg = {
        type: 'space-state',
        selfId: 1,
        members: [],
        apps: { demo: { value: 'x' } },
      };
      const { state: next, effects } = reduceSpace(state, msg, makeCtx({ plugins: [plugin] }));
      assert.deepEqual(next.pluginLocal, { demo: { seen: 'x' } });
      assert.equal(effects.length, 1); // history-title のみ(title が undefined でも push される)
      assert.ok(!effects.some((e) => e.type === 'sound' || e.type.startsWith('notify')));
    });

    it('presence が away なら presence-change を send effect で送り直す', () => {
      const state = initialSpaceState();
      const msg = { type: 'space-state', members: [], selfId: 1 };
      const { effects } = reduceSpace(state, msg, makeCtx({ presence: 'away' }));
      assert.ok(
        effects.some(
          (e) =>
            e.type === 'send' &&
            e.message.type === 'presence-change' &&
            e.message.presence === 'away',
        ),
      );
    });

    it('presence が active なら send effect を出さない', () => {
      const state = initialSpaceState();
      const msg = { type: 'space-state', members: [], selfId: 1 };
      const { effects } = reduceSpace(state, msg, makeCtx({ presence: 'active' }));
      assert.ok(!effects.some((e) => e.type === 'send'));
    });
  });

  describe('member-joined', () => {
    it('同一uidの2台目デバイス入室では log/音/通知を出さない', () => {
      const state = { ...initialSpaceState(), members: [{ id: 1, name: 'Alice', uid: 'u1' }] };
      const msg = {
        type: 'member-joined',
        member: { id: 2, name: 'Alice(phone)', uid: 'u1' },
        members: [
          { id: 1, name: 'Alice', uid: 'u1' },
          { id: 2, name: 'Alice(phone)', uid: 'u1' },
        ],
      };
      const { state: next, effects } = reduceSpace(state, msg, makeCtx());
      assert.deepEqual(next.members, msg.members);
      assert.equal(effects.length, 0);
      assert.equal(next.chatLines.length, 0);
    });

    it('resumed(サーバー再起動由来の再接続)でも出さない', () => {
      const state = initialSpaceState();
      const msg = {
        type: 'member-joined',
        member: { id: 2, name: 'Bob', uid: null },
        members: [{ id: 2, name: 'Bob', uid: null }],
        resumed: true,
      };
      const { effects, state: next } = reduceSpace(state, msg, makeCtx());
      assert.equal(effects.length, 0);
      assert.equal(next.chatLines.length, 0);
    });

    it('初回入室では log 追加 + sound:join + notify-join を出す', () => {
      const state = initialSpaceState();
      const msg = {
        type: 'member-joined',
        member: { id: 2, name: 'Bob', uid: null },
        members: [{ id: 2, name: 'Bob', uid: null }],
      };
      const { state: next, effects } = reduceSpace(state, msg, makeCtx());
      assert.equal(next.chatLines.length, 1);
      assert.equal(next.chatLines[0].kind, 'log');
      assert.ok(effects.some((e) => e.type === 'sound' && e.sound === 'join'));
      assert.ok(effects.some((e) => e.type === 'notify-join' && e.name === 'Bob'));
    });
  });

  describe('member-left', () => {
    it('members を置換し、退室者の app-relay ペイロードだけ掃除する', () => {
      const state = {
        ...initialSpaceState(),
        members: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
        appRelay: {
          whiteboard: { Alice: { kind: 'draw' }, Bob: { kind: 'draw' } },
        },
      };
      const msg = { type: 'member-left', members: [{ id: 1, name: 'Alice' }] };
      const { state: next } = reduceSpace(state, msg, makeCtx());
      assert.deepEqual(next.members, [{ id: 1, name: 'Alice' }]);
      assert.deepEqual(next.appRelay.whiteboard, { Alice: { kind: 'draw' } });
    });
  });

  describe('chat', () => {
    it('行を追加し sound:chat・notify-chat を出し、入力中表示を即座に消す', () => {
      const state = { ...initialSpaceState(), typingUsers: ['Bob'] };
      const msg = { type: 'chat', name: 'Bob', text: 'hello', id: 10, createdAt: 500 };
      const { state: next, effects } = reduceSpace(state, msg, makeCtx());
      assert.equal(next.chatLines.length, 1);
      assert.equal(next.chatLines[0].name, 'Bob');
      assert.equal(next.chatLines[0].self, false);
      assert.deepEqual(next.typingUsers, []);
      assert.ok(effects.some((e) => e.type === 'sound' && e.sound === 'chat'));
      assert.ok(
        effects.some((e) => e.type === 'notify-chat' && e.name === 'Bob' && e.text === 'hello'),
      );
      assert.ok(effects.some((e) => e.type === 'typing-timer-clear' && e.name === 'Bob'));
    });
  });

  describe('chat-ack', () => {
    it('clientMsgId 一致行に id と createdAt を反映する', () => {
      const state = {
        ...initialSpaceState(),
        chatLines: [
          {
            key: 1,
            kind: 'chat' as const,
            name: 'Alice',
            text: 'hi',
            clientMsgId: 'c1',
            id: null,
            createdAt: 1,
          },
        ],
      };
      const msg = { type: 'chat-ack', clientMsgId: 'c1', id: 99, createdAt: 12345 };
      const { state: next } = reduceSpace(state, msg, makeCtx());
      assert.equal(next.chatLines[0].id, 99);
      assert.equal(next.chatLines[0].createdAt, 12345);
    });
  });

  describe('chat-reaction-update', () => {
    it('reactedByMe が selfName から導出される', () => {
      const state = {
        ...initialSpaceState(),
        chatLines: [
          { key: 1, kind: 'chat' as const, name: 'Bob', text: 'hi', id: 5, reactions: {} },
        ],
      };
      const msg = {
        type: 'chat-reaction-update',
        messageId: 5,
        reactions: { '👍': { count: 2, names: ['Alice', 'Bob'] } },
      };
      const { state: next } = reduceSpace(state, msg, makeCtx({ selfName: 'Alice' }));
      assert.deepEqual(next.chatLines[0].reactions, {
        '👍': { count: 2, reactedByMe: true, names: ['Alice', 'Bob'] },
      });
    });
  });

  describe('message-pinned', () => {
    it('pinnedMessage を置換するだけで、ログ行も effect も出さない', () => {
      const pinned = { id: 5, name: 'Bob', text: 'hi', kind: 'chat' };
      const { state: pinnedState, effects: pinEffects } = reduceSpace(
        initialSpaceState(),
        { type: 'message-pinned', pinned, by: 'Bob' },
        makeCtx(),
      );
      assert.deepEqual(pinnedState.pinnedMessage, pinned);
      // ピン留めは固定表示そのものが結果を示すので、チャットにログ行を積まない。
      assert.equal(pinnedState.chatLines.length, 0);
      assert.equal(pinEffects.length, 0);

      const { state: unpinned, effects: unpinEffects } = reduceSpace(
        pinnedState,
        { type: 'message-pinned', pinned: null, by: 'Bob' },
        makeCtx(),
      );
      assert.equal(unpinned.pinnedMessage, null);
      assert.equal(unpinned.chatLines.length, 0);
      assert.equal(unpinEffects.length, 0);
    });
  });

  describe('app-state (plugin 非依存の core 挙動)', () => {
    it('plugin 記述子を1つも渡さなくても apps[appId] は最新値で置換される', () => {
      const msg = {
        type: 'app-state',
        appId: 'whiteboard',
        action: 'add-shape',
        by: 'Alice',
        state: { shapes: [{ id: 1 }] },
      };
      const { state: next, effects } = reduceSpace(initialSpaceState(), msg, makeCtx());
      assert.deepEqual(next.apps.whiteboard, msg.state);
      // plugin が無いので、ログも effect も一切出ない。
      assert.equal(next.chatLines.length, 0);
      assert.equal(effects.length, 0);
    });

    it('ダミー plugin の onAppState が返す local/lines/effects が反映される', () => {
      const plugin: PluginClient = {
        id: 'demo',
        onAppState: ({ local, msg, ctx }) => ({
          local: { count: (local?.count ?? 0) + 1 },
          lines: [{ kind: 'log', icon: 'star', by: msg.by, text: ctx.t('log.demo') }],
          effects: [{ type: 'plugin-sound', appId: 'demo', sound: 'ding' }],
        }),
      };
      const state = { ...initialSpaceState(), pluginLocal: { demo: { count: 5 } } };
      const msg = { type: 'app-state', appId: 'demo', by: 'Bob', state: { value: 1 } };
      const { state: next, effects } = reduceSpace(state, msg, makeCtx({ plugins: [plugin] }));
      assert.deepEqual(next.apps.demo, { value: 1 });
      assert.deepEqual(next.pluginLocal.demo, { count: 6 });
      assert.equal(next.chatLines.length, 1);
      assert.equal(next.chatLines[0].by, 'Bob');
      assert.ok(
        effects.some((e) => e.type === 'plugin-sound' && e.appId === 'demo' && e.sound === 'ding'),
      );
    });

    it('appId が一致しない plugin は呼ばれない', () => {
      let called = false;
      const plugin: PluginClient = {
        id: 'demo',
        onAppState: () => {
          called = true;
          return {};
        },
      };
      const msg = { type: 'app-state', appId: 'whiteboard', state: {} };
      reduceSpace(initialSpaceState(), msg, makeCtx({ plugins: [plugin] }));
      assert.equal(called, false);
    });
  });

  describe('app-relay', () => {
    it('在室していない送信者からのリレーは捨てる', () => {
      const state = { ...initialSpaceState(), members: [{ id: 1, name: 'Alice' }] };
      const msg = {
        type: 'app-relay',
        appId: 'whiteboard',
        by: 'Ghost',
        payload: { kind: 'draw' },
      };
      const { state: next } = reduceSpace(state, msg, makeCtx());
      assert.deepEqual(next.appRelay, {});
    });

    it('在室している送信者のリレーは保持する', () => {
      const state = { ...initialSpaceState(), members: [{ id: 1, name: 'Alice' }] };
      const msg = {
        type: 'app-relay',
        appId: 'whiteboard',
        by: 'Alice',
        payload: { kind: 'draw' },
      };
      const { state: next } = reduceSpace(state, msg, makeCtx());
      assert.deepEqual(next.appRelay.whiteboard.Alice, { kind: 'draw' });
    });
  });

  describe('agent-status', () => {
    it('idle 後に遅れて届いた同 requestId の working は無視される', () => {
      const idleMsg = { type: 'agent-status', agentId: 'a1', requestId: 'r1', phase: 'idle' };
      const { state: afterIdle } = reduceSpace(initialSpaceState(), idleMsg, makeCtx());
      const lateWorking = {
        type: 'agent-status',
        agentId: 'a1',
        requestId: 'r1',
        phase: 'working',
      };
      const { state: next, effects } = reduceSpace(afterIdle, lateWorking, makeCtx());
      assert.equal(next, afterIdle); // 同一参照(state 変更なし)
      assert.equal(effects.length, 0);
    });

    it('別 requestId の idle は現在の実況を消さない', () => {
      const workingMsg = { type: 'agent-status', agentId: 'a1', requestId: 'r2', phase: 'working' };
      const { state: afterWorking } = reduceSpace(initialSpaceState(), workingMsg, makeCtx());
      const staleIdle = { type: 'agent-status', agentId: 'a1', requestId: 'r1', phase: 'idle' };
      const { state: next } = reduceSpace(afterWorking, staleIdle, makeCtx());
      assert.deepEqual(next.agentStatuses.a1, {
        requestId: 'r2',
        phase: 'working',
        tool: undefined,
      });
    });

    it('endedRuns が32件で頭から捨てられる', () => {
      let state = initialSpaceState();
      for (let i = 0; i < 33; i++) {
        const msg = { type: 'agent-status', agentId: 'a1', requestId: `r${i}`, phase: 'idle' };
        state = reduceSpace(state, msg, makeCtx()).state;
      }
      assert.equal(state.endedAgentRuns.length, 32);
      assert.ok(!state.endedAgentRuns.includes('r0'));
      assert.ok(state.endedAgentRuns.includes('r32'));
    });
  });

  describe('typing', () => {
    it('typingUsers に追加し typing-timer effect を出す', () => {
      const { state: next, effects } = reduceSpace(
        initialSpaceState(),
        { type: 'typing', name: 'Bob' },
        makeCtx(),
      );
      assert.deepEqual(next.typingUsers, ['Bob']);
      assert.ok(effects.some((e) => e.type === 'typing-timer' && e.name === 'Bob'));
    });
  });

  // 旧実装は setTypingUsers(prev => prev.includes(n) ? prev : …) / ref 代入で、無変化のときに
  // React の再レンダリングを起こさなかった。state へ引き上げた以上、reducer 側で同一参照を
  // 返して同じ回数に保つ（typing は1秒周期で届くので、ここを落とすと入力中ずっと再レンダリングする）。
  describe('無変化のときは state を同一参照で返す（再レンダリング回数の維持）', () => {
    it('typing: 既に入力中の相手なら state は同一参照（タイマー effect は毎回出す）', () => {
      const state = { ...initialSpaceState(), typingUsers: ['Bob'] };
      const { state: next, effects } = reduceSpace(
        state,
        { type: 'typing', name: 'Bob' },
        makeCtx(),
      );
      assert.equal(next, state);
      assert.ok(effects.some((e) => e.type === 'typing-timer' && e.name === 'Bob'));
    });

    it('typing: 初出の相手なら state は更新される', () => {
      const state = { ...initialSpaceState(), typingUsers: ['Bob'] };
      const { state: next } = reduceSpace(state, { type: 'typing', name: 'Carol' }, makeCtx());
      assert.deepEqual(next.typingUsers, ['Bob', 'Carol']);
    });

    it('screen-share-state: 同じ共有者の再送なら state は同一参照', () => {
      const state = {
        ...initialSpaceState(),
        selfId: 1,
        screenShareSharer: { id: 2, name: 'Bob' },
      };
      const { state: next } = reduceSpace(
        state,
        { type: 'screen-share-state', sharer: { id: 2, name: 'Bob' } },
        makeCtx(),
      );
      assert.equal(next, state);
    });

    it('screen-share-state: 共有者なしの再送でも state は同一参照', () => {
      const state = { ...initialSpaceState(), selfId: 1 };
      const { state: next } = reduceSpace(
        state,
        { type: 'screen-share-state', sharer: null },
        makeCtx(),
      );
      assert.equal(next, state);
    });

    it('screen-share-state: 同じ id でも表示名が変われば更新する', () => {
      const state = {
        ...initialSpaceState(),
        selfId: 1,
        screenShareSharer: { id: 2, name: 'Bob' },
      };
      const { state: next } = reduceSpace(
        state,
        { type: 'screen-share-state', sharer: { id: 2, name: 'Bobby' } },
        makeCtx(),
      );
      assert.deepEqual(next.screenShareSharer, { id: 2, name: 'Bobby' });
    });

    it('screen-share-state: なし→ありの遷移ではログを出して更新する', () => {
      const state = { ...initialSpaceState(), selfId: 1 };
      const { state: next } = reduceSpace(
        state,
        { type: 'screen-share-state', sharer: { id: 2, name: 'Bob' } },
        makeCtx(),
      );
      assert.deepEqual(next.screenShareSharer, { id: 2, name: 'Bob' });
      assert.equal(next.chatLines.length, 1);
      assert.equal(next.chatLines[0].by, 'Bob');
    });

    it('screen-share-state: 自分が開始したときはログを出さないが state は更新する', () => {
      const state = { ...initialSpaceState(), selfId: 2 };
      const { state: next } = reduceSpace(
        state,
        { type: 'screen-share-state', sharer: { id: 2, name: 'Me' } },
        makeCtx(),
      );
      assert.deepEqual(next.screenShareSharer, { id: 2, name: 'Me' });
      assert.equal(next.chatLines.length, 0);
    });
  });

  describe('未知の type', () => {
    it('state を同一参照で返す', () => {
      const state = initialSpaceState();
      const { state: next, effects } = reduceSpace(state, { type: 'nonsense' }, makeCtx());
      assert.equal(next, state);
      assert.equal(effects.length, 0);
    });
  });
});

// endedAgentRuns（終了済み実行の印）は接続と同じ寿命でなければならない。ここを落とすと、
// 表示名を変えて接続を張り直したときだけ印が持ち越され、そのときだけ挙動が変わる。
describe('resetConnection', () => {
  it('connected を戻し endedAgentRuns も捨てる', () => {
    const state = { ...initialSpaceState(), connected: true, endedAgentRuns: ['req-1'] };
    const next = resetConnection(state);
    assert.equal(next.connected, false);
    assert.deepEqual(next.endedAgentRuns, []);
  });

  it('既に接続前で印も無ければ同一参照を返す', () => {
    const state = initialSpaceState();
    assert.equal(resetConnection(state), state);
  });

  it('connected が false でも印が残っていれば捨てる', () => {
    const state = { ...initialSpaceState(), endedAgentRuns: ['req-1'] };
    const next = resetConnection(state);
    assert.notEqual(next, state);
    assert.deepEqual(next.endedAgentRuns, []);
  });
});
