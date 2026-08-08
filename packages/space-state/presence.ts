// Treating one signed-in person as one person, however many devices they are
// connected from.
//
// The server keeps sending every connection in the member list, and that is
// deliberate: a client identifies itself by `m.id === selfId`, so a server
// that merged connections would make a member's own row disappear on their
// second device. Merging is therefore a display-side decision, and it lives
// here.
//
// A guest (no `uid`) stays one entry per connection, as before — there is
// nothing to merge them by.

type MemberLike = { id: number; uid?: string | null; presence?: 'active' | 'away' };

/**
 * Collapses `members` to one entry per `uid`, for display.
 *
 * Entries without a `uid` are left alone. Among the connections of one person,
 * the one matching `selfId` wins, and otherwise the first seen does. Order
 * follows where each `uid` first appeared.
 */
export function dedupeMembersByUid<T extends MemberLike>(members: T[], selfId: number | null): T[] {
  // First pass: pick the entry to show for each uid — self if present,
  // otherwise the first occurrence. A later self never loses to an earlier
  // non-self, and a later non-self never displaces self.
  const chosenByUid = new Map<string, T>();
  for (const m of members) {
    if (!m.uid) continue;
    const current = chosenByUid.get(m.uid);
    if (!current) {
      chosenByUid.set(m.uid, m);
    } else if (current.id !== selfId && m.id === selfId) {
      chosenByUid.set(m.uid, m);
    }
  }
  // Presence is decided independently of which connection got picked: if any
  // one of a person's connections is active, the person is active. Reading it
  // off the chosen entry alone would show someone as away because the phone
  // in their pocket is idle, while they are working at their desk.
  const activeUids = new Set<string>();
  for (const m of members) {
    if (m.uid && (m.presence ?? 'active') === 'active') activeUids.add(m.uid);
  }
  // Second pass: emit the chosen entry at the position where its uid first
  // appeared, and drop the later duplicates.
  const result: T[] = [];
  const emittedUid = new Set<string>();
  for (const m of members) {
    if (!m.uid) {
      result.push(m);
      continue;
    }
    if (emittedUid.has(m.uid)) continue;
    emittedUid.add(m.uid);
    // biome-ignore lint/style/noNonNullAssertion: the first pass set every uid present here
    const chosen = chosenByUid.get(m.uid)!;
    const presence = activeUids.has(m.uid) ? 'active' : 'away';
    result.push((chosen.presence ?? 'active') === presence ? chosen : { ...chosen, presence });
  }
  return result;
}

/**
 * Whether `joined` is this person's *first* connection — i.e. whether their
 * arrival is worth announcing.
 *
 * A guest (no `uid`) always counts as first. A signed-in member counts as
 * first unless another of their connections was already present in
 * `prevMembers`, which must be the member list from *before* this join.
 */
export function isFirstConnectionOfUid(prevMembers: MemberLike[], joined: MemberLike): boolean {
  if (!joined.uid) return true;
  return !prevMembers.some((m) => m.uid === joined.uid && m.id !== joined.id);
}
