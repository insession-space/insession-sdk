/**
 * Who is in the room.
 *
 * This is the half of a space that is not any extension's business: the set
 * of live connections, their presence, and the question every announcement
 * depends on — "is this a new person, or the same person's second device?"
 *
 * All of it is pure. Connections are identified by an opaque `connId` the
 * host assigns; this package never sees a socket.
 */

/** One live connection. Not one person — see `isFirstConnectionOfUid`. */
export interface SpaceMember {
  /** The host's identifier for this connection. Unique while the connection is open. */
  connId: string;
  name: string;
  /**
   * The account behind the connection, or `null` for a guest.
   *
   * Guests are counted per connection; signed-in members are counted per
   * account, which is what makes the same person on a laptop and a phone one
   * arrival rather than two.
   */
  uid: string | null;
  presence: 'active' | 'away';
}

/** The whole room: who is here, plus each extension's slice. */
export interface RoomState {
  members: SpaceMember[];
  extensions: Record<string, unknown>;
}

/** Whether `connId` is currently in `members`. */
export function hasConnection(members: SpaceMember[], connId: string): boolean {
  return members.some((m) => m.connId === connId);
}

/** The member for `connId`, or `undefined`. */
export function findMember(members: SpaceMember[], connId: string): SpaceMember | undefined {
  return members.find((m) => m.connId === connId);
}

/**
 * Whether joining `member` is this person's *first* connection.
 *
 * A guest (`uid: null`) is always first — there is no account to tie two
 * connections together, so each one is its own arrival. A signed-in member is
 * first only if no other connection already carries the same `uid`.
 *
 * Call this *before* adding the member. Hosts use it to decide whether to
 * announce an arrival: without it, opening a second tab reads as a second
 * person walking in.
 */
export function isFirstConnectionOfUid(members: SpaceMember[], member: SpaceMember): boolean {
  if (!member.uid) return true;
  return !members.some((m) => m.uid === member.uid && m.connId !== member.connId);
}

/**
 * Whether the connection `connId` is this person's *last* one.
 *
 * Call this *before* removing it. The mirror of `isFirstConnectionOfUid`, and
 * needed for the same reason: closing one of two tabs is not a departure.
 * An unknown `connId` counts as last (there is nothing left of them either
 * way), so a duplicate disconnect does not announce twice.
 */
export function isLastConnectionOfUid(members: SpaceMember[], connId: string): boolean {
  const member = findMember(members, connId);
  if (!member?.uid) return true;
  return !members.some((m) => m.uid === member.uid && m.connId !== connId);
}

/**
 * Adds a connection, replacing any entry that already holds the same
 * `connId`.
 *
 * Replacing rather than appending matters because a host that re-joins an
 * existing connection (a re-authentication, a name change) would otherwise
 * end up with the same connection listed twice, and the duplicate would
 * never be removed — `removeConnection` deletes by id and would leave the
 * second copy behind, showing a ghost in the room forever.
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

/**
 * Sets one connection's presence. Returns the same array when nothing changed,
 * so a host can skip announcing a no-op.
 */
export function setPresence(
  members: SpaceMember[],
  connId: string,
  presence: 'active' | 'away',
): SpaceMember[] {
  const member = findMember(members, connId);
  if (!member || member.presence === presence) return members;
  return members.map((m) => (m.connId === connId ? { ...m, presence } : m));
}

/**
 * Collapses the connection list to one entry per person, for display.
 *
 * Guests are left as they are. For a signed-in member, the first connection
 * holds the slot, and the person counts as `active` if *any* of their
 * connections is — otherwise someone working at their laptop shows as away
 * because their phone is asleep.
 *
 * The room's own `members` deliberately stays per-connection: the host needs
 * every socket to deliver to, and a client identifies itself by `connId`.
 * Collapsing is a presentation concern, so it is offered rather than applied.
 */
export function dedupeByUid(members: SpaceMember[]): SpaceMember[] {
  const activeUids = new Set<string>();
  for (const m of members) {
    if (m.uid && m.presence === 'active') activeUids.add(m.uid);
  }
  const seen = new Set<string>();
  const out: SpaceMember[] = [];
  for (const m of members) {
    if (!m.uid) {
      out.push(m);
      continue;
    }
    if (seen.has(m.uid)) continue;
    seen.add(m.uid);
    const presence = activeUids.has(m.uid) ? 'active' : 'away';
    out.push(m.presence === presence ? m : { ...m, presence });
  }
  return out;
}
