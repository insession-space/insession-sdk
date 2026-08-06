// Run with: node --test packages/extension-pomodoro
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  defaultState,
  onTimer as onTimerWithEffects,
  type PomodoroPayload,
  type PomodoroState,
  persistState,
  reduce as reduceWithEffects,
  restore,
  timerDelay,
} from './index.ts';

// `reduce`/`onTimer` return `{ state, effects }`. The assertions below are
// about the state transition, so they go through these unwrapping shims;
// the effects themselves are asserted directly in the "Effects" section at
// the bottom of this file.
const reduce = (
  state: PomodoroState | null | undefined,
  action: string,
  payload?: PomodoroPayload,
): PomodoroState | null => reduceWithEffects(state, action, payload)?.state ?? null;
const onTimer = (state: PomodoroState): PomodoroState => onTimerWithEffects(state).state;

// Every test that depends on Date.now() replaces it for the duration of the
// test and restores it afterwards, so timing is deterministic.
function withFrozenClock<T>(nowMs: number, fn: () => T): T {
  const orig = Date.now;
  Date.now = () => nowMs;
  try {
    return fn();
  } finally {
    Date.now = orig;
  }
}

const NOW = 1_700_000_000_000;

test('defaultState is stopped, in the work phase, with no declarations/participants', () => {
  const s = defaultState();
  assert.equal(s.running, false);
  assert.equal(s.phase, 'work');
  assert.equal(s.endsAt, null);
  assert.equal(s.remaining, 25 * 60);
  assert.deepEqual(s.config, { work: 25 * 60, break: 5 * 60 });
  assert.equal(s.cycles, 0);
  assert.deepEqual(s.declarations, {});
  assert.deepEqual(s.participants, {});
});

// --- start ------------------------------------------------------------

test('start: sets running and endsAt from remaining', () => {
  const s = withFrozenClock(NOW, () => reduce(defaultState(), 'start'));
  assert.ok(s);
  assert.equal(s?.running, true);
  assert.equal(s?.endsAt, NOW + 25 * 60 * 1000);
});

test('start: returns null when already running', () => {
  const running: PomodoroState = { ...defaultState(), running: true, endsAt: NOW + 1000 };
  assert.equal(reduce(running, 'start'), null);
});

// --- pause --------------------------------------------------------------

test('pause: stops and computes remaining from endsAt', () => {
  const running: PomodoroState = { ...defaultState(), running: true, endsAt: NOW + 10_000 };
  const s = withFrozenClock(NOW, () => reduce(running, 'pause'));
  assert.ok(s);
  assert.equal(s?.running, false);
  assert.equal(s?.endsAt, null);
  assert.equal(s?.remaining, 10); // 10_000ms → 10s
});

test('pause: returns null when already stopped', () => {
  assert.equal(reduce(defaultState(), 'pause'), null);
});

// --- reset ----------------------------------------------------------------

test('reset: carries over declarations, participants, and config; drops running/cycles', () => {
  const s: PomodoroState = {
    running: true,
    phase: 'break',
    endsAt: NOW + 5000,
    remaining: 12,
    config: { work: 30 * 60, break: 10 * 60 },
    cycles: 4,
    declarations: { alice: { text: 'ship it', uid: 'u1', cheers: ['bob'] } },
    participants: { alice: { uid: 'u1' }, bob: { uid: null } },
  };
  const next = reduce(s, 'reset');
  assert.ok(next);
  assert.equal(next?.running, false);
  assert.equal(next?.phase, 'work');
  assert.equal(next?.endsAt, null);
  assert.equal(next?.cycles, 0);
  assert.deepEqual(next?.config, s.config);
  assert.equal(next?.remaining, s.config.work);
  assert.deepEqual(next?.declarations, s.declarations);
  assert.deepEqual(next?.participants, s.participants);
});

// --- skip -------------------------------------------------------------

test('skip: advances phase without counting a cycle, stopped state keeps endsAt null', () => {
  const s = defaultState();
  const next = reduce(s, 'skip');
  assert.ok(next);
  assert.equal(next?.phase, 'break');
  assert.equal(next?.cycles, 0);
  assert.equal(next?.endsAt, null);
  assert.equal(next?.remaining, s.config.break);
});

test('skip: while running, sets endsAt for the new phase', () => {
  const running: PomodoroState = { ...defaultState(), running: true, endsAt: NOW + 1000 };
  const next = withFrozenClock(NOW, () => reduce(running, 'skip'));
  assert.ok(next);
  assert.equal(next?.endsAt, NOW + (next?.config.break ?? 0) * 1000);
});

// --- configure --------------------------------------------------------

test('configure: clamps minutes below MIN_MINUTES up to 1 minute', () => {
  const next = reduce(defaultState(), 'configure', { workMinutes: 0, breakMinutes: -5 });
  assert.ok(next);
  assert.equal(next?.config.work, 60);
  assert.equal(next?.config.break, 60);
});

test('configure: clamps minutes above MAX_MINUTES down to 120 minutes', () => {
  const next = reduce(defaultState(), 'configure', { workMinutes: 999, breakMinutes: 500 });
  assert.ok(next);
  assert.equal(next?.config.work, 120 * 60);
  assert.equal(next?.config.break, 120 * 60);
});

test('configure: values that fail Number() conversion fall back to the existing config', () => {
  const s = defaultState();
  const next = reduce(s, 'configure', { workMinutes: 'nope', breakMinutes: undefined });
  assert.ok(next);
  assert.equal(next?.config.work, s.config.work);
  assert.equal(next?.config.break, s.config.break);
});

test('configure: values that convert to 0 (null, "", false, []) clamp to 1 minute rather than falling back', () => {
  // Number(null) === 0, Number('') === 0, Number(false) === 0, Number([]) === 0 —
  // all finite, so clampMinutes clamps them to MIN_MINUTES instead of using the
  // fallback path (which only triggers on non-finite conversions like NaN).
  for (const value of [null, '', false, []]) {
    const next = reduce(defaultState(), 'configure', { workMinutes: value, breakMinutes: value });
    assert.ok(next);
    assert.equal(next?.config.work, 60, `workMinutes: ${JSON.stringify(value)}`);
    assert.equal(next?.config.break, 60, `breakMinutes: ${JSON.stringify(value)}`);
  }
});

test('configure: updates remaining to match the current phase duration', () => {
  const s = defaultState(); // phase: 'work'
  const next = reduce(s, 'configure', { workMinutes: 45 });
  assert.ok(next);
  assert.equal(next?.remaining, 45 * 60);
});

test('configure: returns null while running', () => {
  const running: PomodoroState = { ...defaultState(), running: true, endsAt: NOW + 1000 };
  assert.equal(reduce(running, 'configure', { workMinutes: 10 }), null);
});

// --- declare ------------------------------------------------------------

test('declare: text is trimmed and clamped to 80 chars', () => {
  const longText = `  ${'x'.repeat(100)}  `;
  const next = reduce(defaultState(), 'declare', { by: 'alice', text: longText, uid: 'u1' });
  assert.ok(next);
  assert.equal(next?.declarations.alice.text.length, 80);
  assert.equal(next?.declarations.alice.text, 'x'.repeat(80));
});

test('declare: changing text resets cheers; unchanged text keeps them', () => {
  const s: PomodoroState = {
    ...defaultState(),
    declarations: { alice: { text: 'ship it', uid: 'u1', cheers: ['bob', 'carol'] } },
  };
  const changed = reduce(s, 'declare', { by: 'alice', text: 'ship it v2', uid: 'u1' });
  assert.ok(changed);
  assert.deepEqual(changed?.declarations.alice.cheers, []);

  const sameTextNewUid = reduce(s, 'declare', { by: 'alice', text: 'ship it', uid: 'u2' });
  assert.ok(sameTextNewUid);
  assert.deepEqual(sameTextNewUid?.declarations.alice.cheers, ['bob', 'carol']);
});

test('declare: empty text clears an existing declaration', () => {
  const s: PomodoroState = {
    ...defaultState(),
    declarations: { alice: { text: 'ship it', uid: 'u1', cheers: [] } },
  };
  const next = reduce(s, 'declare', { by: 'alice', text: '', uid: 'u1' });
  assert.ok(next);
  assert.equal('alice' in (next?.declarations ?? {}), false);
});

test('declare: empty text on a member with no declaration is a no-op (null)', () => {
  assert.equal(reduce(defaultState(), 'declare', { by: 'alice', text: '' }), null);
});

test('declare: unchanged text/uid is a no-op (null)', () => {
  const s: PomodoroState = {
    ...defaultState(),
    declarations: { alice: { text: 'ship it', uid: 'u1', cheers: [] } },
  };
  assert.equal(reduce(s, 'declare', { by: 'alice', text: 'ship it', uid: 'u1' }), null);
});

test('declare: missing `by` returns null', () => {
  assert.equal(reduce(defaultState(), 'declare', { text: 'hi' }), null);
});

// --- cheer ----------------------------------------------------------------

test('cheer: toggles a name onto and off of a declaration', () => {
  const s: PomodoroState = {
    ...defaultState(),
    declarations: { alice: { text: 'ship it', uid: 'u1', cheers: [] } },
  };
  const cheered = reduce(s, 'cheer', { target: 'alice', by: 'bob' });
  assert.ok(cheered);
  assert.deepEqual(cheered?.declarations.alice.cheers, ['bob']);

  assert.ok(cheered);
  const uncheered = reduce(cheered, 'cheer', { target: 'alice', by: 'bob' });
  assert.ok(uncheered);
  assert.deepEqual(uncheered?.declarations.alice.cheers, []);
});

test('cheer: cheering your own declaration returns null', () => {
  const s: PomodoroState = {
    ...defaultState(),
    declarations: { alice: { text: 'ship it', uid: 'u1', cheers: [] } },
  };
  assert.equal(reduce(s, 'cheer', { target: 'alice', by: 'alice' }), null);
});

test('cheer: cheering an undeclared target returns null', () => {
  assert.equal(reduce(defaultState(), 'cheer', { target: 'alice', by: 'bob' }), null);
});

// --- join / leave -----------------------------------------------------

test('join: adds a participant; unchanged uid is a no-op (null)', () => {
  const next = reduce(defaultState(), 'join', { by: 'alice', uid: 'u1' });
  assert.ok(next);
  assert.deepEqual(next?.participants.alice, { uid: 'u1' });
  assert.ok(next);
  assert.equal(reduce(next, 'join', { by: 'alice', uid: 'u1' }), null);
});

test('join: missing `by` returns null', () => {
  assert.equal(reduce(defaultState(), 'join', { uid: 'u1' }), null);
});

test('leave: removes a participant', () => {
  const s: PomodoroState = { ...defaultState(), participants: { alice: { uid: 'u1' } } };
  const next = reduce(s, 'leave', { by: 'alice' });
  assert.ok(next);
  assert.equal('alice' in (next?.participants ?? {}), false);
});

test('leave: not participating is a no-op (null)', () => {
  assert.equal(reduce(defaultState(), 'leave', { by: 'alice' }), null);
});

// --- unknown action -----------------------------------------------------

test('unknown action returns null', () => {
  assert.equal(reduce(defaultState(), 'not-a-real-action'), null);
});

test('reduce falls back to defaultState() when given null/undefined state', () => {
  const next = reduce(null, 'skip');
  assert.ok(next);
  assert.equal(next?.phase, 'break');
});

// --- timerDelay -----------------------------------------------------------

test('timerDelay: null while stopped', () => {
  assert.equal(timerDelay(defaultState()), null);
});

test('timerDelay: positive remaining ms while running', () => {
  const running: PomodoroState = { ...defaultState(), running: true, endsAt: NOW + 7_000 };
  const delay = withFrozenClock(NOW, () => timerDelay(running));
  assert.equal(delay, 7_000);
});

// --- onTimer ------------------------------------------------------------

test('onTimer: work → break increments cycles', () => {
  const s: PomodoroState = { ...defaultState(), running: true, phase: 'work', cycles: 2 };
  const next = withFrozenClock(NOW, () => onTimer(s));
  assert.equal(next.phase, 'break');
  assert.equal(next.cycles, 3);
});

test('onTimer: break → work does not increment cycles', () => {
  const s: PomodoroState = { ...defaultState(), running: true, phase: 'break', cycles: 2 };
  const next = withFrozenClock(NOW, () => onTimer(s));
  assert.equal(next.phase, 'work');
  assert.equal(next.cycles, 2);
});

// --- persistState -----------------------------------------------------

test('persistState: empties participants', () => {
  const s: PomodoroState = { ...defaultState(), participants: { alice: { uid: 'u1' } } };
  const next = persistState(s);
  assert.deepEqual(next.participants, {});
});

test('persistState: returns the same object when participants is already empty', () => {
  const s = defaultState();
  assert.equal(persistState(s), s);
});

// --- restore ------------------------------------------------------------

test('restore: null/string input returns null', () => {
  assert.equal(restore(null), null);
  assert.equal(restore('nope'), null);
});

test('restore: array input is typeof "object" so it falls through to a safe default state', () => {
  // Arrays pass the `typeof raw === 'object'` guard (same as the ported
  // source), so this is not a null-returning case — it's covered here to
  // document that array input degrades to a safe default rather than null.
  const next = restore([1, 2, 3]);
  assert.ok(next);
  assert.equal(next?.running, false);
  assert.deepEqual(next?.declarations, {});
  assert.deepEqual(next?.participants, {});
});

test('restore: always stopped with endsAt null', () => {
  const next = restore({ running: true, endsAt: 123, phase: 'work' });
  assert.ok(next);
  assert.equal(next?.running, false);
  assert.equal(next?.endsAt, null);
});

test('restore: remaining is clamped to the phase duration', () => {
  const overLong = restore({
    phase: 'work',
    remaining: 99_999,
    config: { work: 1500, break: 300 },
  });
  assert.ok(overLong);
  assert.equal(overLong?.remaining, 1500);

  const negative = restore({ phase: 'work', remaining: -50, config: { work: 1500, break: 300 } });
  assert.ok(negative);
  assert.equal(negative?.remaining, 0);
});

test('restore: drops declarations without a string uid', () => {
  const next = restore({
    declarations: {
      alice: { text: 'has uid', uid: 'u1', cheers: [] },
      bob: { text: 'no uid (guest)', uid: null, cheers: [] },
      carol: { text: 'non-string uid', uid: 42, cheers: [] },
    },
  });
  assert.ok(next);
  assert.deepEqual(Object.keys(next?.declarations ?? {}), ['alice']);
});

test('restore: caps declarations at 200 and cheers at 200, deduping cheers', () => {
  const declarations: Record<string, unknown> = {};
  for (let i = 0; i < 250; i++) {
    declarations[`member-${i}`] = { text: `task ${i}`, uid: `u${i}`, cheers: [] };
  }
  const cappedDeclarations = restore({ declarations });
  assert.ok(cappedDeclarations);
  assert.equal(Object.keys(cappedDeclarations?.declarations ?? {}).length, 200);

  const manyCheers = Array.from({ length: 250 }, (_, i) => `cheerer-${i % 210}`); // has dupes
  const next = restore({
    declarations: { alice: { text: 'ship it', uid: 'u1', cheers: manyCheers } },
  });
  assert.ok(next);
  const cheers = next?.declarations.alice.cheers ?? [];
  assert.equal(new Set(cheers).size, cheers.length); // deduped
  // manyCheers dedupes down to 210 distinct names before the cap is applied,
  // so the capped result is always exactly 200, not merely "at most" 200.
  assert.equal(cheers.length, 200);
});

test('restore: participants is always empty regardless of input', () => {
  const next = restore({ participants: { alice: { uid: 'u1' } } });
  assert.ok(next);
  assert.deepEqual(next?.participants, {});
});

test('restore: falls back to defaults for missing/invalid config, phase, cycles', () => {
  const next = restore({});
  assert.ok(next);
  assert.deepEqual(next?.config, defaultState().config);
  assert.equal(next?.phase, 'work');
  assert.equal(next?.cycles, 0);

  const withBreak = restore({ phase: 'break' });
  assert.equal(withBreak?.phase, 'break');

  const withGarbageCycles = restore({ cycles: 'not-a-number' });
  assert.equal(withGarbageCycles?.cycles, 0);

  const withNegativeCycles = restore({ cycles: -5 });
  assert.equal(withNegativeCycles?.cycles, 0);
});

// Member-name payload fields are rejected when they aren't strings, rather
// than being coerced into an object key. This is one of a few intentional
// behavioral differences from the implementation this package was ported
// from, which relied on JavaScript's implicit key coercion (`decls[5]` →
// `decls['5']`) and could therefore let a non-string reach the
// `cheers: string[]` array. (See below for the other differences: rejecting
// `Object.prototype`-inherited member names, and normalizing `uid`.)
test('reduce: non-string member names are rejected, not coerced', () => {
  for (const by of [5, true, { toString: () => 'alice' }, ['alice']]) {
    assert.equal(reduce(null, 'declare', { by, text: 'hi', uid: 'u1' }), null);
    assert.equal(reduce(null, 'join', { by, uid: 'u1' }), null);
    assert.equal(reduce(null, 'leave', { by }), null);
  }

  const declared = reduce(null, 'declare', { by: 'alice', text: 'hi', uid: 'u1' });
  assert.ok(declared);
  // A non-string `target` must not reach a member whose name merely
  // stringifies to the same value.
  for (const target of [5, true, ['alice']]) {
    assert.equal(reduce(declared, 'cheer', { by: 'bob', target }), null);
  }
  // ...and a non-string `by` must never be appended to `cheers`.
  for (const by of [5, true]) {
    assert.equal(reduce(declared, 'cheer', { by, target: 'alice' }), null);
  }
});

// Member names that collide with inherited `Object.prototype` properties
// (`constructor`, `toString`, `hasOwnProperty`, `__proto__`) must be treated
// as "no existing entry", not resolve to the inherited value. Before the
// `Object.hasOwn` guards were added, these all threw a `TypeError` (e.g.
// reading `.includes` off `Object.prototype.constructor` in `cheer`) —
// this is a regression test for that crash. `target`/`by` are wire-controlled
// values, so this was reachable from an untrusted client.
test('reduce: prototype-inherited member names are treated as absent, not thrown on', () => {
  const protoNames = ['constructor', 'toString', 'hasOwnProperty', '__proto__'];

  for (const target of protoNames) {
    assert.doesNotThrow(() => reduce(defaultState(), 'cheer', { by: 'bob', target }));
    assert.equal(reduce(defaultState(), 'cheer', { by: 'bob', target }), null);
  }

  for (const by of protoNames) {
    assert.doesNotThrow(() => reduce(defaultState(), 'declare', { by, text: 'hi', uid: 'u1' }));
    const declared = reduce(defaultState(), 'declare', { by, text: 'hi', uid: 'u1' });
    assert.ok(declared);
    assert.equal(declared?.declarations[by]?.text, 'hi');

    assert.doesNotThrow(() => reduce(defaultState(), 'join', { by, uid: 'u1' }));
    const joined = reduce(defaultState(), 'join', { by, uid: 'u1' });
    assert.ok(joined);
    assert.deepEqual(joined?.participants[by], { uid: 'u1' });

    assert.doesNotThrow(() => reduce(defaultState(), 'leave', { by }));
    assert.equal(reduce(defaultState(), 'leave', { by }), null); // not participating → no-op
  }
});

// --- uid normalization --------------------------------------------------

test('declare/join: non-string uid is normalized to null, not cast through', () => {
  const declared = reduce(defaultState(), 'declare', { by: 'alice', text: 'hi', uid: 42 });
  assert.ok(declared);
  assert.equal(declared?.declarations.alice.uid, null);

  const joined = reduce(defaultState(), 'join', { by: 'alice', uid: 42 });
  assert.ok(joined);
  assert.equal(joined?.participants.alice.uid, null);
});

// --- pause clamp ----------------------------------------------------------

test('pause: clamps remaining to 0 when endsAt is already in the past', () => {
  const running: PomodoroState = { ...defaultState(), running: true, endsAt: NOW - 10_000 };
  const next = withFrozenClock(NOW, () => reduce(running, 'pause'));
  assert.ok(next);
  assert.equal(next?.remaining, 0);
});

// --- timerDelay clamp -------------------------------------------------

test('timerDelay: clamps to 0 when endsAt is already in the past', () => {
  const running: PomodoroState = { ...defaultState(), running: true, endsAt: NOW - 5_000 };
  const delay = withFrozenClock(NOW, () => timerDelay(running));
  assert.equal(delay, 0);
});

// --- sanitizeDeclarations (via restore) --------------------------------

test('restore: drops non-string cheer entries while keeping valid ones', () => {
  const next = restore({
    declarations: { alice: { text: 'ship it', uid: 'u1', cheers: ['x', 1, null] } },
  });
  assert.ok(next);
  assert.deepEqual(next?.declarations.alice.cheers, ['x']);
});

// --- restore remaining clamp for the break phase -----------------------

test('restore: remaining is clamped to the break length when phase is "break"', () => {
  const next = restore({
    phase: 'break',
    remaining: 99_999,
    config: { work: 1500, break: 300 },
  });
  assert.ok(next);
  assert.equal(next?.remaining, 300);
});

// --- onTimer on a stopped state -----------------------------------------

test('onTimer: applied to a stopped state keeps endsAt null', () => {
  const s: PomodoroState = { ...defaultState(), running: false, phase: 'work' };
  const next = withFrozenClock(NOW, () => onTimer(s));
  assert.equal(next.phase, 'break');
  assert.equal(next.endsAt, null);
});

// --- whitespace-only declaration text -----------------------------------

test('declare: whitespace-only text clears an existing declaration', () => {
  const s: PomodoroState = {
    ...defaultState(),
    declarations: { alice: { text: 'ship it', uid: 'u1', cheers: [] } },
  };
  const next = reduce(s, 'declare', { by: 'alice', text: '  ', uid: 'u1' });
  assert.ok(next);
  assert.equal('alice' in (next?.declarations ?? {}), false);
});

// A member whose display name is `__proto__` must round-trip like any other.
// A plain `out[name] = ...` in restore would invoke the `__proto__` setter,
// swapping the returned object's prototype for stored data: the declaration
// would silently vanish and `for...in` would start yielding `text`/`uid`/
// `cheers` from the swapped prototype.
test('restore: a __proto__ member name becomes an own key, not a prototype swap', () => {
  const declared = reduce(null, 'declare', { by: '__proto__', text: 'hello', uid: 'u1' });
  assert.ok(declared);
  // Simulate the storage round trip the host performs (JSON in, JSON out).
  const persisted = JSON.parse(JSON.stringify(persistState(declared)));

  const back = restore(persisted);
  assert.ok(back);
  assert.equal(Object.getPrototypeOf(back.declarations), Object.prototype);
  assert.ok(Object.hasOwn(back.declarations, '__proto__'));
  assert.deepEqual(back.declarations['__proto__'], { text: 'hello', uid: 'u1', cheers: [] });
  assert.deepEqual(Object.keys(back.declarations), ['__proto__']);
  // Nothing leaked onto the global prototype.
  assert.equal(({} as Record<string, unknown>).text, undefined);
});

// ── Effects ────────────────────────────────────────────────────────────────
//
// Declarations are the only thing here that outlives a session, so they are
// the only source of effects. Everything else changes state and nothing else.

test('declare by a signed-in member asks the host to store it', () => {
  const r = reduceWithEffects(defaultState(), 'declare', {
    by: 'Ada',
    uid: 'u1',
    text: 'ship the thing',
  });
  assert.ok(r);
  assert.deepEqual(r.effects, [{ type: 'persist-declaration', uid: 'u1', text: 'ship the thing' }]);
});

test('a guest declaration is state-only: nothing is stored', () => {
  // By design — a guest has no account to key storage by.
  const r = reduceWithEffects(defaultState(), 'declare', { by: 'Anon', text: 'lurking' });
  assert.ok(r);
  assert.equal(r.state.declarations.Anon.text, 'lurking');
  assert.deepEqual(r.effects, []);
});

test('clearing a declaration asks the host to delete it', () => {
  const declared = reduceWithEffects(defaultState(), 'declare', {
    by: 'Ada',
    uid: 'u1',
    text: 'ship it',
  });
  assert.ok(declared);
  const cleared = reduceWithEffects(declared.state, 'declare', { by: 'Ada', uid: 'u1', text: '' });
  assert.ok(cleared);
  assert.equal(cleared.state.declarations.Ada, undefined);
  assert.deepEqual(cleared.effects, [{ type: 'delete-declaration', uid: 'u1' }]);
});

test('clearing a guest declaration stores nothing and deletes nothing', () => {
  const declared = reduceWithEffects(defaultState(), 'declare', { by: 'Anon', text: 'x' });
  assert.ok(declared);
  const cleared = reduceWithEffects(declared.state, 'declare', { by: 'Anon', text: '' });
  assert.ok(cleared);
  assert.deepEqual(cleared.effects, []);
});

test('attaching a uid to an existing text stores it, and keeps the cheers', () => {
  // The text is unchanged, so cheers survive — but storage has not seen this
  // declaration before, so it still has to be written.
  const guest = reduceWithEffects(defaultState(), 'declare', { by: 'Ada', text: 'same text' });
  assert.ok(guest);
  const cheered = reduceWithEffects(guest.state, 'cheer', { by: 'Bob', target: 'Ada' });
  assert.ok(cheered);
  assert.deepEqual(cheered.effects, [], 'cheering never touches storage');

  const signedIn = reduceWithEffects(cheered.state, 'declare', {
    by: 'Ada',
    uid: 'u1',
    text: 'same text',
  });
  assert.ok(signedIn);
  assert.deepEqual(signedIn.state.declarations.Ada.cheers, ['Bob']);
  assert.deepEqual(signedIn.effects, [
    { type: 'persist-declaration', uid: 'u1', text: 'same text' },
  ]);
});

test('re-declaring the identical text and uid is a no-op, so nothing is stored', () => {
  const first = reduceWithEffects(defaultState(), 'declare', { by: 'Ada', uid: 'u1', text: 'x' });
  assert.ok(first);
  // The reducer rejects it outright, which is also "no write".
  assert.equal(
    reduceWithEffects(first.state, 'declare', { by: 'Ada', uid: 'u1', text: 'x' }),
    null,
  );
});

test('phase changes produce no effects, from either entry point', () => {
  const declared = reduceWithEffects(defaultState(), 'declare', {
    by: 'Ada',
    uid: 'u1',
    text: 'x',
  });
  assert.ok(declared);
  const started = reduceWithEffects(declared.state, 'start');
  assert.ok(started);
  assert.deepEqual(started.effects, []);
  assert.deepEqual(onTimerWithEffects(started.state).effects, []);
});

test('a wire-controlled member name cannot reach an inherited declaration', () => {
  // Same guard as the reducer's: `Object.hasOwn`, not a bare lookup. Without
  // it, `by: 'constructor'` would compare against Object.prototype.constructor
  // and could emit a bogus effect.
  const r = reduceWithEffects(defaultState(), 'declare', {
    by: 'constructor',
    uid: 'u1',
    text: 'hi',
  });
  assert.ok(r);
  assert.deepEqual(r.effects, [{ type: 'persist-declaration', uid: 'u1', text: 'hi' }]);
});
