/**
 * Presence, and the one place a per-connection list is collapsed to a
 * per-person one.
 */
import { findMember } from './list.ts';
import type { SpaceMember } from './types.ts';

/**
 * Sets one connection's presence. Returns the same array when nothing
 * changed, so a host can cheaply skip announcing a no-op.
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
 * because their phone went to sleep.
 *
 * The space's own list deliberately stays per-connection: the host needs every
 * socket to deliver to, and a client identifies itself by `connId`.
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
