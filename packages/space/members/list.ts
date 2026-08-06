/**
 * The connection list: adding, removing, looking up.
 *
 * All pure, all over a plain array. Connections are identified by an opaque
 * `connId` the host assigns; this package never sees a socket.
 */
import type { SpaceMember } from './types.ts';

/** Whether `connId` is currently connected. */
export function hasConnection(members: SpaceMember[], connId: string): boolean {
  return members.some((m) => m.connId === connId);
}

/** The member for `connId`, or `undefined`. */
export function findMember(members: SpaceMember[], connId: string): SpaceMember | undefined {
  return members.find((m) => m.connId === connId);
}

/**
 * Adds a connection, replacing any entry that already holds the same
 * `connId`.
 *
 * Replacing rather than appending matters because a host that re-joins an
 * existing connection (a re-authentication, a name change) would otherwise
 * end up with the same connection listed twice, and the duplicate would never
 * be removed — `removeConnection` deletes by id and would leave the second
 * copy behind, showing a ghost in the member list forever.
 */
export function addConnection(members: SpaceMember[], member: SpaceMember): SpaceMember[] {
  const existing = members.findIndex((m) => m.connId === member.connId);
  if (existing === -1) return [...members, member];
  const next = [...members];
  next[existing] = member;
  return next;
}

/** Removes a connection. Returns the same array when `connId` was not present. */
export function removeConnection(members: SpaceMember[], connId: string): SpaceMember[] {
  if (!hasConnection(members, connId)) return members;
  return members.filter((m) => m.connId !== connId);
}
