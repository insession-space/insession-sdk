import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addConnection, findMember, hasConnection, removeConnection } from './list.ts';
import type { SpaceMember } from './types.ts';

function member(connId: string, uid: string | null, presence: 'active' | 'away' = 'active') {
  return { connId, name: `n-${connId}`, uid, presence } satisfies SpaceMember;
}

test('addConnection appends, and replaces an entry with the same connId', () => {
  const a = member('a', null);
  const one = addConnection([], a);
  assert.deepEqual(one, [a]);

  // A re-join on a live connection (re-auth, name change) must not leave a
  // second copy behind — removeConnection deletes by id and the duplicate
  // would linger as a ghost forever.
  const replaced = addConnection(one, { ...a, name: 'renamed' });
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
