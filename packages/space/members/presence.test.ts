import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dedupeByUid, setPresence } from './presence.ts';
import type { SpaceMember } from './types.ts';

function member(connId: string, uid: string | null, presence: 'active' | 'away' = 'active') {
  return { connId, name: `n-${connId}`, uid, presence } satisfies SpaceMember;
}

test('setPresence returns the same array for a no-op, so hosts can skip announcing', () => {
  const members = [member('a', 'u1', 'active')];
  assert.equal(setPresence(members, 'a', 'active'), members, 'already active');
  assert.equal(setPresence(members, 'ghost', 'away'), members, 'unknown connection');
  const changed = setPresence(members, 'a', 'away');
  assert.notEqual(changed, members);
  assert.equal(changed[0].presence, 'away');
});

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

test('dedupeByUid preserves the caller own row shape', () => {
  // Hosts have their own richer member row (avatar, what the client is looking
  // at, ...). Collapsing must not force it through this package's shape — the
  // entries come back as they went in, apart from `presence`.
  const rows = [
    { id: 1, uid: 'u1', presence: 'away' as const, avatar: 'a.png', stage: 'player' },
    { id: 2, uid: 'u1', presence: 'active' as const, avatar: 'a.png', stage: 'chat' },
    { id: 3, uid: null, presence: 'active' as const, avatar: null, stage: null },
  ];
  const out = dedupeByUid(rows);
  assert.deepEqual(
    out.map((r) => r.id),
    [1, 3],
  );
  assert.equal(out[0].avatar, 'a.png', 'extra fields survive');
  assert.equal(out[0].stage, 'player', 'the first connection holds the slot');
  assert.equal(out[0].presence, 'active', 'one active device makes the person active');
});
