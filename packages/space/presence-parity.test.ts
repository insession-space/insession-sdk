/**
 * Parity: this package and `@insession/space-state` collapse a connection list
 * to one entry per person, and they must not drift apart.
 *
 * There are two implementations on purpose. `space-state` runs on the client,
 * where a member identifies *itself* by `id === selfId`, so the surviving entry
 * for the signed-in viewer has to be their own connection — otherwise the UI
 * loses track of which row is "me". This package runs on the server, where
 * there is no "self": it is answering "who is here" on behalf of everyone. So
 * `dedupeMembersByUid` takes a `selfId` and `dedupeByUid` does not.
 *
 * That single difference is deliberate. **Everything else has to agree**, and
 * nothing enforced it until this file: the same person on two devices is one
 * entry, guests are never collapsed, order follows first appearance, and one
 * active device makes the person active. Fixing a bug in one copy and not the
 * other shows up as the member count on the server disagreeing with the list on
 * screen — with no failing test anywhere.
 *
 * ⚠ The import is a **relative path into the sibling source**, not the package
 * name, for the reasons spelled out at the top of `conformance.test.ts`: a
 * dependency here would be a runtime dependency, and `devDependencies` would
 * resolve to a `dist` that `pnpm verify` never builds.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dedupeMembersByUid } from '../space-state/presence.ts';
import { dedupeByUid } from './members/presence.ts';
import type { SpaceMember } from './members/types.ts';

/** The client's member shape. Its `id` is this package's `connId`, as a number. */
type ClientMember = { id: number; uid?: string | null; presence?: 'active' | 'away' };

/**
 * One fixture, expressed in both shapes. `connId` is the stringified `id`, so a
 * result from either side can be compared by the same key.
 */
function pair(members: Array<[id: number, uid: string | null, presence?: 'active' | 'away']>) {
  const client: ClientMember[] = members.map(([id, uid, presence = 'active']) => ({
    id,
    uid,
    presence,
  }));
  const server: SpaceMember[] = members.map(([id, uid, presence = 'active']) => ({
    connId: String(id),
    name: `n-${id}`,
    uid,
    presence,
  }));
  return { client, server };
}

/** Both results reduced to the same comparable form: which connection survived, and how. */
const fromClient = (rows: ClientMember[]) =>
  rows.map((m) => `${m.id}:${m.uid ?? '-'}:${m.presence ?? 'active'}`);
const fromServer = (rows: SpaceMember[]) =>
  rows.map((m) => `${m.connId}:${m.uid ?? '-'}:${m.presence}`);

/**
 * Asserts the two agree. `selfId` is `null` so the client's one extra rule —
 * preferring the viewer's own connection — is not in play; that difference gets
 * its own test below.
 */
function assertAgree(
  members: Array<[number, string | null, ('active' | 'away')?]>,
  message: string,
) {
  const { client, server } = pair(members);
  assert.deepEqual(
    fromServer(dedupeByUid(server)),
    fromClient(dedupeMembersByUid(client, null)),
    message,
  );
}

test('one person on two devices collapses to one entry on both sides', () => {
  assertAgree(
    [
      [1, 'u1'],
      [2, 'u1'],
    ],
    'two connections, one person',
  );
});

test('guests are never collapsed on either side, however many there are', () => {
  // There is no account tying two guest connections together, so each stays.
  assertAgree(
    [
      [1, null],
      [2, null],
      [3, null],
    ],
    'three guests stay three',
  );
});

test('order follows first appearance on both sides', () => {
  assertAgree(
    [
      [1, 'u1'],
      [2, null],
      [3, 'u2'],
      [4, 'u1'],
      [5, 'u2'],
    ],
    'later duplicates are dropped, they do not move the slot',
  );
});

test('one active device makes the person active on both sides', () => {
  // Otherwise someone working at their laptop reads as away because their phone
  // went to sleep — a bug both sides were written to avoid, in the same way.
  assertAgree(
    [
      [1, 'u1', 'away'],
      [2, 'u1', 'active'],
    ],
    'away first, active second',
  );
  assertAgree(
    [
      [1, 'u1', 'active'],
      [2, 'u1', 'away'],
    ],
    'active first, away second',
  );
  assertAgree(
    [
      [1, 'u1', 'away'],
      [2, 'u1', 'away'],
    ],
    'every device away stays away',
  );
});

test('guests and signed-in members interleaved agree on both sides', () => {
  assertAgree(
    [
      [1, null, 'away'],
      [2, 'u1', 'away'],
      [3, null],
      [4, 'u1', 'active'],
      [5, 'u2', 'away'],
      [6, null, 'away'],
    ],
    'a realistic mixed list',
  );
});

test('an empty list and a single connection agree on both sides', () => {
  assertAgree([], 'empty');
  assertAgree([[1, 'u1']], 'one signed-in');
  assertAgree([[1, null]], 'one guest');
});

test('the one deliberate difference: the client keeps the viewer own connection', () => {
  // This is the rule that justifies two implementations existing at all. The
  // client must keep the connection whose `id === selfId`, because that is how
  // a member recognizes itself in the list. The server has no viewer, so it
  // keeps the first connection like any other.
  const { client, server } = pair([
    [1, 'u1'],
    [2, 'u1'],
  ]);

  assert.deepEqual(
    dedupeMembersByUid(client, 2).map((m) => m.id),
    [2],
    'client: the viewer own connection wins, even though it appeared second',
  );
  assert.deepEqual(
    dedupeByUid(server).map((m) => m.connId),
    ['1'],
    'server: first appearance wins, there being no viewer',
  );

  // The slot itself does not move: only which connection fills it changes.
  assert.equal(dedupeMembersByUid(client, 2).length, dedupeByUid(server).length);
});
