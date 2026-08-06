import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SpaceEffect } from './effects.ts';
import { defineSpaceExtension } from './extension.ts';
import { createSpace } from './space.ts';

const Counter = defineSpaceExtension<{ count: number; running: boolean }>({
  name: 'counter',
  server: {
    defaultState: () => ({ count: 0, running: false }),
    reduce(state, action) {
      const s = state ?? { count: 0, running: false };
      if (action === 'inc') return { ...s, count: s.count + 1 };
      if (action === 'start') return { ...s, running: true };
      return null;
    },
    timerDelay: (s) => (s.running ? 500 : null),
    onTimer: (s) => ({ ...s, running: false, count: s.count + 100 }),
    restore: (raw) =>
      raw && typeof raw === 'object'
        ? { count: Number((raw as { count?: unknown }).count) || 0, running: false }
        : null,
  },
  client: { initLocal: () => ({}) },
});

function space() {
  return createSpace({ extensions: [Counter] });
}

const types = (effects: SpaceEffect[]) => effects.map((e) => e.type);

// ── Join ───────────────────────────────────────────────────────────────────

test('a fresh space starts empty with every extension at its default', () => {
  const s = space();
  assert.equal(s.isEmpty(), true);
  assert.deepEqual(s.getState().extensions, { counter: { count: 0, running: false } });
});

test('joining replies with a snapshot and announces the arrival', () => {
  const s = space();
  const effects = s.join({ connId: 'a', name: 'Ada', uid: 'u1' });
  assert.deepEqual(types(effects), ['send-to-sender', 'broadcast']);
  assert.deepEqual(effects[0], {
    type: 'send-to-sender',
    message: {
      type: 'space-state',
      selfId: 'a',
      members: [{ connId: 'a', name: 'Ada', uid: 'u1', presence: 'active' }],
      extensions: { counter: { count: 0, running: false } },
    },
  });
  // The arrival announcement skips the person who just arrived; their own
  // snapshot already told them they are here.
  assert.equal((effects[1] as { excludeSender?: boolean }).excludeSender, true);
  assert.equal(s.isEmpty(), false);
});

test('a second device gets its snapshot but is not announced as an arrival', () => {
  const s = space();
  s.join({ connId: 'a', name: 'Ada', uid: 'u1' });
  const effects = s.join({ connId: 'b', name: 'Ada', uid: 'u1' });
  assert.deepEqual(types(effects), ['send-to-sender']);
  assert.equal(s.members().length, 2, 'both sockets are tracked');
  assert.equal(s.people().length, 1, 'but it is one person');
});

test('two guests are two arrivals even with the same name', () => {
  const s = space();
  s.join({ connId: 'a', name: 'Anon' });
  const effects = s.join({ connId: 'b', name: 'Anon' });
  assert.deepEqual(types(effects), ['send-to-sender', 'broadcast']);
});

test('re-joining a live connection re-syncs it without announcing again', () => {
  const s = space();
  s.join({ connId: 'a', name: 'Ada', uid: 'u1' });
  const effects = s.join({ connId: 'a', name: 'Ada Lovelace', uid: 'u1' });
  assert.deepEqual(types(effects), ['send-to-sender']);
  assert.equal(s.members().length, 1, 'no duplicate entry left behind');
  assert.equal(s.members()[0].name, 'Ada Lovelace');
});

// ── Leave ──────────────────────────────────────────────────────────────────

test('leaving announces a departure only when the last device goes', () => {
  const s = space();
  s.join({ connId: 'a', name: 'Ada', uid: 'u1' });
  s.join({ connId: 'b', name: 'Ada', uid: 'u1' });

  assert.deepEqual(types(s.leave('b')), [], 'closing one tab is not leaving');
  assert.deepEqual(types(s.leave('a')), ['broadcast']);
  assert.equal(s.isEmpty(), true);
});

test('an unknown or repeated disconnect is a silent no-op', () => {
  const s = space();
  s.join({ connId: 'a', name: 'Ada', uid: 'u1' });
  assert.deepEqual(types(s.leave('a')), ['broadcast'], 'the real departure');
  // A socket that closes twice (close event plus heartbeat timeout) must not
  // announce a second departure.
  assert.deepEqual(types(s.leave('a')), [], 'the repeat');
  assert.deepEqual(types(s.leave('never-here')), []);
});

// ── Presence ───────────────────────────────────────────────────────────────

test('presence broadcasts only on an actual change', () => {
  const s = space();
  s.join({ connId: 'a', name: 'Ada', uid: 'u1' });
  assert.deepEqual(types(s.setPresence('a', 'active')), [], 'already active');
  assert.deepEqual(types(s.setPresence('a', 'away')), ['broadcast']);
  assert.deepEqual(types(s.setPresence('ghost', 'away')), [], 'unknown connection');
  assert.equal(s.members()[0].presence, 'away');
});

// ── Extension actions ──────────────────────────────────────────────────────

test('dispatch applies the action and returns its effects', () => {
  const s = space();
  const effects = s.dispatch('counter', 'inc');
  assert.deepEqual(types(effects), ['broadcast', 'clear-timer']);
  assert.deepEqual(s.getState().extensions.counter, { count: 1, running: false });
});

test('dispatch is an empty no-op for the three wire-boundary cases', () => {
  const s = space();
  assert.deepEqual(s.dispatch('nope', 'inc'), [], 'unknown extension');
  assert.deepEqual(s.dispatch('counter', 'bogus'), [], 'rejected action');
  assert.deepEqual(s.getState().extensions.counter, { count: 0, running: false }, 'unchanged');
});

test('a timer is armed on the transition that needs it and fired by name', () => {
  const s = space();
  const started = s.dispatch('counter', 'start');
  assert.deepEqual(started.at(-1), { type: 'schedule-timer', extension: 'counter', delayMs: 500 });

  const fired = s.fireTimer('counter');
  assert.deepEqual(types(fired), ['broadcast', 'clear-timer']);
  assert.deepEqual(s.getState().extensions.counter, { count: 100, running: false });
  assert.deepEqual(s.fireTimer('nope'), []);
});

// ── Storage ────────────────────────────────────────────────────────────────

test('snapshot and hydrate round-trip the extension slices, leaving members alone', () => {
  const s = space();
  s.join({ connId: 'a', name: 'Ada', uid: 'u1' });
  s.dispatch('counter', 'inc');

  const stored = s.snapshot();
  assert.deepEqual(stored, { counter: { count: 1, running: false } });

  const fresh = space();
  fresh.join({ connId: 'x', name: 'Bob' });
  fresh.hydrate(stored);
  assert.deepEqual(fresh.getState().extensions.counter, { count: 1, running: false });
  assert.equal(fresh.members().length, 1, 'hydrate does not touch who is in the room');
});

test('armTimers re-derives every extension timer after a restart', () => {
  // A restart drops the host's in-flight timers; the state that needed them
  // comes back from storage, so what to re-arm has to be recomputed.
  const s = space();
  s.hydrate({ counter: { count: 5 } });
  assert.deepEqual(s.armTimers(), [{ type: 'clear-timer', extension: 'counter' }]);

  s.dispatch('counter', 'start');
  assert.deepEqual(s.armTimers(), [{ type: 'schedule-timer', extension: 'counter', delayMs: 500 }]);
});

// ── Wire format ────────────────────────────────────────────────────────────

test('every message builder is injectable, since the wire is the host protocol', () => {
  const s = createSpace({
    extensions: [Counter],
    buildSyncMessage: ({ self }) => ({ t: 'sync', me: self.connId }),
    buildJoinMessage: ({ member }) => ({ t: 'in', who: member.name }),
    buildLeaveMessage: ({ member }) => ({ t: 'out', who: member.name }),
    buildPresenceMessage: ({ member }) => ({ t: 'presence', p: member.presence }),
    buildStateMessage: ({ extension }) => ({ t: 'ext', extension }),
  });
  const joined = s.join({ connId: 'a', name: 'Ada', uid: 'u1' });
  assert.deepEqual((joined[0] as { message: unknown }).message, { t: 'sync', me: 'a' });
  assert.deepEqual((joined[1] as { message: unknown }).message, { t: 'in', who: 'Ada' });
  assert.deepEqual((s.setPresence('a', 'away')[0] as { message: unknown }).message, {
    t: 'presence',
    p: 'away',
  });
  assert.deepEqual((s.dispatch('counter', 'inc')[0] as { message: unknown }).message, {
    t: 'ext',
    extension: 'counter',
  });
  assert.deepEqual((s.leave('a')[0] as { message: unknown }).message, { t: 'out', who: 'Ada' });
});

test('clientExtensions carries the client facets through', () => {
  assert.deepEqual(
    space()
      .clientExtensions()
      .map((c) => c.id),
    ['counter'],
  );
});
