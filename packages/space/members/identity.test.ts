import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isFirstConnectionOfUid, isLastConnectionOfUid } from './identity.ts';
import type { SpaceMember } from './types.ts';

function member(connId: string, uid: string | null) {
  return { connId, name: `n-${connId}`, uid, presence: 'active' } satisfies SpaceMember;
}

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

  assert.equal(
    isLastConnectionOfUid([laptop, phone], 'b'),
    false,
    'closing one tab is not leaving',
  );
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
