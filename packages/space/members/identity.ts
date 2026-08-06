/**
 * Is this a new person, or the same person's second device?
 *
 * Every announcement in a space depends on this question, and getting it
 * wrong is immediately visible: opening a second tab reads as a second person
 * walking in, and closing one of two tabs reads as leaving.
 *
 * The connection list stays per-connection (the host has to deliver to every
 * socket). These two predicates are how a per-connection list answers a
 * per-person question.
 */
import { findMember } from './list.ts';
import type { SpaceMember } from './types.ts';

/**
 * Whether joining `member` is this person's *first* connection.
 *
 * A guest (`uid: null`) is always first — there is no account to tie two
 * connections together, so each one is its own arrival. A signed-in member is
 * first only if no *other* connection already carries the same `uid`; the
 * member's own `connId` is excluded so that re-joining a live connection does
 * not read as "someone else with my account is here", which would suppress
 * the arrival forever.
 *
 * Call this *before* adding the member — afterwards they are always present
 * and every arrival looks like a second device.
 */
export function isFirstConnectionOfUid(members: SpaceMember[], member: SpaceMember): boolean {
  if (!member.uid) return true;
  return !members.some((m) => m.uid === member.uid && m.connId !== member.connId);
}

/**
 * Whether the connection `connId` is this person's *last* one.
 *
 * Call this *before* removing it. The mirror of `isFirstConnectionOfUid`, and
 * needed for the same reason. An unknown `connId` counts as last (there is
 * nothing left of them either way), so a socket that closes twice — a close
 * event *and* a heartbeat timeout — does not announce a second departure.
 */
export function isLastConnectionOfUid(members: SpaceMember[], connId: string): boolean {
  const member = findMember(members, connId);
  if (!member?.uid) return true;
  return !members.some((m) => m.uid === member.uid && m.connId !== connId);
}
