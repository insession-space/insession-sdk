import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createExtensionRegistry,
  defineSpaceExtension,
  type ExtensionState,
  type SpaceEffect,
  type SpaceExtension,
} from '../index.ts';

// The fixtures below deliberately mirror the two reducer shapes that already
// exist in this repo, so the contract is exercised against real signatures
// rather than an idealized one:
//
//   `counter` -> `plugin-pomodoro-state`: returns a bare state, has timers,
//                strips a session-only field in `persistState`.
//   `board`   -> `chat-state` / `plugin-watch-party-state`: returns
//                `{ state, effects }`, mixes core message effects with
//                domain-specific ones, no timers.

type CounterState = { count: number; running: boolean; endsAt: number | null; viewers: string[] };

const Counter = defineSpaceExtension<CounterState>({
  name: 'counter',
  options: { step: 1 },
  server: {
    defaultState: () => ({ count: 0, running: false, endsAt: null, viewers: [] }),
    reduce(state, action) {
      const s = state ?? { count: 0, running: false, endsAt: null, viewers: [] };
      switch (action) {
        case 'inc':
          return { ...s, count: s.count + 1 };
        case 'start':
          return s.running ? null : { ...s, running: true, endsAt: 1_000 };
        case 'stop':
          return { ...s, running: false, endsAt: null };
        default:
          return null;
      }
    },
    timerDelay: (s) => (s.running && s.endsAt !== null ? s.endsAt : null),
    onTimer: (s) => ({ ...s, count: s.count + 100, running: false, endsAt: null }),
    restore: (raw) =>
      raw && typeof raw === 'object'
        ? {
            count: Number((raw as { count?: unknown }).count) || 0,
            // A restored counter always comes back stopped, like the real ones.
            running: false,
            endsAt: null,
            viewers: [],
          }
        : null,
    // `viewers` is session-only: present in memory, never written to storage.
    persistState: (s) => (s.viewers.length === 0 ? s : { ...s, viewers: [] }),
  },
  client: {
    initLocal: (appState) => ({ count: appState?.count ?? null }),
    onAppState: ({ msg }) => ({ local: { count: msg.state.count }, lines: [{ kind: 'log' }] }),
  },
});

type BoardState = { notes: string[] };

const Board = defineSpaceExtension<BoardState>({
  name: 'board',
  server: {
    defaultState: () => ({ notes: [] }),
    reduce(state, action, payload) {
      const s = state ?? { notes: [] };
      if (action !== 'add') return null;
      const note = String((payload as { note?: unknown })?.note ?? '');
      if (!note) return null;
      return {
        state: { notes: [...s.notes, note] },
        effects: [
          { type: 'send-to-sender', message: { type: 'ack', note } },
          { type: 'persist-notes', notes: [...s.notes, note] },
        ],
      };
    },
  },
});

/** An extension that participates on the client only (no server facet at all). */
const Presence = defineSpaceExtension({
  name: 'presence',
  client: { initLocal: () => ({ seen: 0 }) },
});

function registry(extra: SpaceExtension[] = []) {
  return createExtensionRegistry([Counter as SpaceExtension, Board as SpaceExtension, ...extra]);
}

// ── defineSpaceExtension ───────────────────────────────────────────────────

test('defineSpaceExtension rejects a missing or empty name', () => {
  assert.throws(() => defineSpaceExtension({ name: '' }), TypeError);
  assert.throws(() => defineSpaceExtension({} as SpaceExtension), TypeError);
});

test('defineSpaceExtension returns the extension unchanged', () => {
  const ext = { name: 'x', options: { a: 1 } };
  assert.equal(defineSpaceExtension(ext), ext);
});

// ── Registry construction ──────────────────────────────────────────────────

test('duplicate names are rejected, since a name is also a storage key', () => {
  assert.throws(
    () => createExtensionRegistry([{ name: 'dup' }, { name: 'dup' }]),
    /duplicate extension name "dup"/,
  );
});

test('an extension without a name is rejected', () => {
  assert.throws(() => createExtensionRegistry([{ name: '' }]), TypeError);
  assert.throws(() => createExtensionRegistry('nope' as never), TypeError);
});

test('names keeps the given order, and membership needs no global constant', () => {
  const r = registry([Presence]);
  assert.deepEqual(r.names, ['counter', 'board', 'presence']);
  assert.equal(r.has('counter'), true);
  // The whole point of an open registry: a name nobody declared centrally is
  // present purely because it was passed in.
  assert.equal(r.has('anything-else'), false);
  assert.equal(r.get('board')?.name, 'board');
});

// ── initState ──────────────────────────────────────────────────────────────

test('initState namespaces each slice and skips client-only extensions', () => {
  const state = registry([Presence]).initState();
  assert.deepEqual(state, {
    counter: { count: 0, running: false, endsAt: null, viewers: [] },
    board: { notes: [] },
  });
  assert.equal('presence' in state, false);
});

// ── applyAction ────────────────────────────────────────────────────────────

test('applyAction routes to the right reducer and replaces only that slice', () => {
  const r = registry();
  const before = r.initState();
  const result = r.applyAction(before, 'counter', 'inc');
  assert.ok(result);
  assert.deepEqual(result.state.counter, { count: 1, running: false, endsAt: null, viewers: [] });
  // Untouched slices keep their identity, not just their value.
  assert.equal(result.state.board, before.board);
  // The input is not mutated.
  assert.deepEqual(before.counter, { count: 0, running: false, endsAt: null, viewers: [] });
});

test('applyAction returns null for the three ordinary wire-boundary cases', () => {
  const r = registry([Presence]);
  const state = r.initState();
  assert.equal(r.applyAction(state, 'nope', 'inc'), null, 'unknown extension');
  assert.equal(r.applyAction(state, 'presence', 'inc'), null, 'no server facet');
  assert.equal(r.applyAction(state, 'counter', 'bogus'), null, 'reducer rejected the action');
  assert.equal(r.applyAction(state, 'counter', ''), null, 'empty action name');
});

test('a reducer returning null for a no-op produces no state change at all', () => {
  const r = registry();
  const started = r.applyAction(r.initState(), 'counter', 'start');
  assert.ok(started);
  // `start` while already running is a no-op in the fixture, as it is in the real Pomodoro.
  assert.equal(r.applyAction(started.state, 'counter', 'start'), null);
});

test('a bare-state reducer broadcasts the new slice by default', () => {
  const result = registry().applyAction(registry().initState(), 'counter', 'inc');
  assert.ok(result);
  assert.deepEqual(result.effects[0], {
    type: 'broadcast',
    message: {
      type: 'app-state',
      appId: 'counter',
      state: { count: 1, running: false, endsAt: null, viewers: [] },
    },
  });
});

test('the state broadcast comes before the effects the extension emitted', () => {
  const r = registry();
  const result = r.applyAction(r.initState(), 'board', 'add', { note: 'hi' });
  assert.ok(result);
  assert.equal(result.effects[0].type, 'broadcast');
  assert.equal(result.effects[1].type, 'send-to-sender');
});

test('core message effects pass through unwrapped, domain effects are tagged', () => {
  const r = registry();
  const result = r.applyAction(r.initState(), 'board', 'add', { note: 'hi' });
  assert.ok(result);
  const [, sendToSender, domain] = result.effects;
  // `send-to-sender` is universal, so a host handles it once for every extension.
  assert.deepEqual(sendToSender, { type: 'send-to-sender', message: { type: 'ack', note: 'hi' } });
  // Anything else carries its origin, so two extensions can both have a
  // `persist-notes` effect without the host confusing them.
  assert.deepEqual(domain, {
    type: 'extension',
    extension: 'board',
    effect: { type: 'persist-notes', notes: ['hi'] },
  });
});

test('a slice with its own `state` field is not mistaken for a reduce envelope', () => {
  // The two-key test matters here: "state" is a plausible domain field name
  // (playback state, game state), and misreading it would silently replace
  // the whole slice with its inner value.
  const Tricky = defineSpaceExtension<{ state: string; effects: number }>({
    name: 'tricky',
    server: {
      defaultState: () => ({ state: 'idle', effects: 0 }),
      reduce: () => ({ state: 'playing', effects: 3 }),
    },
  });
  const r = createExtensionRegistry([Tricky as SpaceExtension]);
  const result = r.applyAction(r.initState(), 'tricky', 'go');
  assert.ok(result);
  // `effects: 3` is not an array, so this is a bare state, not an envelope.
  assert.deepEqual(result.state.tricky, { state: 'playing', effects: 3 });
});

test('buildStateMessage lets the host own its wire format', () => {
  const r = createExtensionRegistry([Counter as SpaceExtension], {
    buildStateMessage: ({ extension, state, action }) => ({ t: 'sync', extension, action, state }),
  });
  const result = r.applyAction(r.initState(), 'counter', 'inc');
  assert.ok(result);
  assert.deepEqual(result.effects[0], {
    type: 'broadcast',
    message: {
      t: 'sync',
      extension: 'counter',
      action: 'inc',
      state: { count: 1, running: false, endsAt: null, viewers: [] },
    },
  });
});

test('broadcastOnAction:false leaves sending entirely to the host', () => {
  const r = createExtensionRegistry([Counter as SpaceExtension], { broadcastOnAction: false });
  const result = r.applyAction(r.initState(), 'counter', 'inc');
  assert.ok(result);
  assert.equal(
    result.effects.some((e: SpaceEffect) => e.type === 'broadcast'),
    false,
  );
});

test('excludeSenderOnBroadcast marks the automatic broadcast', () => {
  const r = createExtensionRegistry([Counter as SpaceExtension], {
    excludeSenderOnBroadcast: true,
  });
  const result = r.applyAction(r.initState(), 'counter', 'inc');
  assert.ok(result);
  assert.equal((result.effects[0] as { excludeSender?: boolean }).excludeSender, true);
});

// ── Timers ─────────────────────────────────────────────────────────────────

test('every accepted transition re-derives the timer from the new slice', () => {
  const r = registry();
  const state = r.initState();

  // Nothing pending -> the host is told to cancel, not left with a stale timer.
  const inc = r.applyAction(state, 'counter', 'inc');
  assert.ok(inc);
  assert.deepEqual(inc.effects.at(-1), { type: 'clear-timer', extension: 'counter' });

  const started = r.applyAction(state, 'counter', 'start');
  assert.ok(started);
  assert.deepEqual(started.effects.at(-1), {
    type: 'schedule-timer',
    extension: 'counter',
    delayMs: 1_000,
  });

  // Stopping clears it again — the case a host hand-rolling this forgets.
  const stopped = r.applyAction(started.state, 'counter', 'stop');
  assert.ok(stopped);
  assert.deepEqual(stopped.effects.at(-1), { type: 'clear-timer', extension: 'counter' });
});

test('an extension with no timer facet still gets an explicit clear-timer', () => {
  const r = registry();
  const result = r.applyAction(r.initState(), 'board', 'add', { note: 'hi' });
  assert.ok(result);
  assert.deepEqual(result.effects.at(-1), { type: 'clear-timer', extension: 'board' });
});

test('timerDelay reports what is pending without applying anything', () => {
  const r = registry();
  const state = r.initState();
  assert.equal(r.timerDelay(state, 'counter'), null);
  const started = r.applyAction(state, 'counter', 'start');
  assert.ok(started);
  assert.equal(r.timerDelay(started.state, 'counter'), 1_000);
  assert.equal(r.timerDelay(state, 'board'), null, 'no timer facet');
  assert.equal(r.timerDelay(state, 'nope'), null, 'unknown extension');
});

test('applyTimer advances the slice and broadcasts it like any other change', () => {
  const r = registry();
  const started = r.applyAction(r.initState(), 'counter', 'start');
  assert.ok(started);
  const fired = r.applyTimer(started.state, 'counter');
  assert.ok(fired);
  assert.deepEqual(fired.state.counter, {
    count: 100,
    running: false,
    endsAt: null,
    viewers: [],
  });
  assert.equal(fired.effects[0].type, 'broadcast');
  // Having advanced, the counter is no longer waiting on anything.
  assert.deepEqual(fired.effects.at(-1), { type: 'clear-timer', extension: 'counter' });
});

test('applyTimer is null when the extension has no onTimer or is unknown', () => {
  const r = registry();
  const state = r.initState();
  assert.equal(r.applyTimer(state, 'board'), null);
  assert.equal(r.applyTimer(state, 'nope'), null);
});

// ── Persistence ────────────────────────────────────────────────────────────

test('persist strips session-only fields and leaves other slices alone', () => {
  const r = registry();
  const state: ExtensionState = {
    ...r.initState(),
    counter: { count: 5, running: false, endsAt: null, viewers: ['a'] },
  };
  const persisted = r.persist(state);
  assert.deepEqual(persisted.counter, { count: 5, running: false, endsAt: null, viewers: [] });
  // No persistState on `board`, so its slice passes through by identity.
  assert.equal(persisted.board, state.board);
  assert.notEqual(persisted, state, 'persist does not mutate its input');
});

test('restore normalizes each slice and falls back to defaultState', () => {
  const r = registry();
  const restored = r.restore({ counter: { count: 7 }, board: { notes: ['x'] } });
  assert.deepEqual(restored.counter, { count: 7, running: false, endsAt: null, viewers: [] });
  // `board` has no `restore`, so it is treated as session-only and comes back fresh
  // rather than being trusted straight off storage.
  assert.deepEqual(restored.board, { notes: [] });
});

test('restore of unusable or absent input yields defaults, not a crash', () => {
  const r = registry();
  assert.deepEqual(r.restore(null), r.initState());
  assert.deepEqual(r.restore('garbage'), r.initState());
  assert.deepEqual(r.restore({ counter: 'nonsense' }).counter, {
    count: 0,
    running: false,
    endsAt: null,
    viewers: [],
  });
});

test('restore keeps slices belonging to extensions this host does not run', () => {
  // Two hosts on different extension lists, or an extension temporarily
  // removed, must not destroy the absent one's stored state on the next write.
  const r = createExtensionRegistry([Counter as SpaceExtension]);
  const restored = r.restore({ counter: { count: 1 }, board: { notes: ['keep me'] } });
  assert.deepEqual(restored.board, { notes: ['keep me'] });
  assert.deepEqual(r.persist(restored).board, { notes: ['keep me'] });
});

// ── Client bridge ──────────────────────────────────────────────────────────

test('clientExtensions produces PluginClient-shaped objects', () => {
  const clients = registry([Presence]).clientExtensions();
  assert.deepEqual(
    clients.map((c) => c.id),
    ['counter', 'presence'],
    'only extensions with a client facet, in registration order',
  );
  const counter = clients[0];
  assert.equal(typeof counter.initLocal, 'function');
  assert.deepEqual(counter.initLocal?.({ count: 3 }), { count: 3 });
  assert.deepEqual(counter.onAppState?.({ local: {}, msg: { state: { count: 9 } }, ctx: {} }), {
    local: { count: 9 },
    lines: [{ kind: 'log' }],
  });
});
