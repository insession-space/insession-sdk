import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addConnection,
  dedupeByUid,
  findMember,
  hasConnection,
  isFirstConnectionOfUid,
  isLastConnectionOfUid,
  removeConnection,
  type SpaceMember,
  setPresence,
} from './room.ts';

function member(connId: string, uid: string | null, presence: 'active' | 'away' = 'active') {
  return { connId, name: `n-${connId}`, uid, presence } satisfies SpaceMember;
}

// ── Membership ─────────────────────────────────────────────────────────────

test('addConnection appends, and replaces an entry with the same connId', () => {
  const a = member('a', null);
  const one = addConnection([], a);
  assert.deepEqual(one, [a]);

  // A re-join on a live connection (re-auth, name change) must not leave a
  // second copy behind — removeConnection deletes by id and the duplicate
  // would linger as a ghost forever.
  const renamed = { ...a, name: 'renamed' };
  const replaced = addConnection(one, renamed);
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].name, 'renamed');
});

test('removeConnection returns the same array when nothing matched', () => {
  const members = [member('a', null)];
  assert.equal(removeConnection(members, 'ghost'), members);
  assert.deepEqual(removeConnection(members, 'a'), []);
});

test('hasConnection and findMember look up by connId', () => {
  const members = [member('a', 'u1'), member('b', null)];
  assert.equal(hasConnection(members, 'b'), true);
  assert.equal(hasConnection(members, 'c'), false);
  assert.equal(findMember(members, 'a')?.uid, 'u1');
  assert.equal(findMember(members, 'c'), undefined);
});

// ── Multi-device ───────────────────────────────────────────────────────────

test('a guest is always a first and a last connection', () => {
  // No account ties two guest connections together, so each is its own
  // arrival and its own departure.
  const members = [member('a', null)];
  assert.equal(isFirstConnectionOfUid(members, member('b', null)), true);
  assert.equal(isLastConnectionOfUid(members, 'a'), true);
});

test('a second device is neither an arrival nor, on closing, a departure', () => {
  const laptop = member('a', 'u1');
  const phone = member('b', 'u1');

  assert.equal(isFirstConnectionOfUid([], laptop), true, 'first device arrives');
  assert.equal(isFirstConnectionOfUid([laptop], phone), false, 'second device does not');

  const both = [laptop, phone];
  assert.equal(isLastConnectionOfUid(both, 'b'), false, 'closing one tab is not leaving');
  assert.equal(isLastConnectionOfUid([laptop], 'a'), true, 'closing the last one is');
});

test('isFirstConnectionOfUid ignores the member being re-added', () => {
  // Re-joining an already-present connId must not read as "someone else with
  // my account is here", which would suppress the arrival forever.
  const laptop = member('a', 'u1');
  assert.equal(isFirstConnectionOfUid([laptop], laptop), true);
});

test('an unknown connId counts as a last connection, so a double disconnect is quiet', () => {
  assert.equal(isLastConnectionOfUid([member('a', 'u1')], 'gone'), true);
});

// ── Presence ───────────────────────────────────────────────────────────────

test('setPresence returns the same array for a no-op, so hosts can skip announcing', () => {
  const members = [member('a', 'u1', 'active')];
  assert.equal(setPresence(members, 'a', 'active'), members, 'already active');
  assert.equal(setPresence(members, 'ghost', 'away'), members, 'unknown connection');
  const changed = setPresence(members, 'a', 'away');
  assert.notEqual(changed, members);
  assert.equal(changed[0].presence, 'away');
});

// ── Display collapsing ─────────────────────────────────────────────────────

test('dedupeByUid keeps guests apart and collapses one account into one slot', () => {
  const members = [member('a', 'u1'), member('b', null), member('c', 'u1'), member('d', null)];
  assert.deepEqual(
    dedupeByUid(members).map((m) => m.connId),
    ['a', 'b', 'd'],
    'the first connection holds the slot; order is preserved',
  );
});

test('a person is active if any of their devices is', () => {
  // Otherwise someone working at their laptop shows as away because their
  // phone went to sleep.
  const collapsed = dedupeByUid([member('a', 'u1', 'away'), member('b', 'u1', 'active')]);
  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0].connId, 'a');
  assert.equal(collapsed[0].presence, 'active');
});

test('a person with every device away stays away', () => {
  const collapsed = dedupeByUid([member('a', 'u1', 'away'), member('b', 'u1', 'away')]);
  assert.deepEqual(
    collapsed.map((m) => m.presence),
    ['away'],
  );
});
