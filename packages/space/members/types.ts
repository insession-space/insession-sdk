/**
 * Who a space is made of.
 *
 * Kept apart from the functions so that `members` / `identity` / `presence`
 * can each import the shape without importing each other.
 */

/**
 * One live connection. **Not one person** — the same account open on a laptop
 * and a phone is two members here, which is the distinction the rest of this
 * directory exists to handle.
 */
export interface SpaceMember {
  /** The host's identifier for this connection. Unique while the connection is open. */
  connId: string;
  name: string;
  /**
   * The account behind the connection, or `null` for a guest.
   *
   * Guests are counted per connection; signed-in members are counted per
   * account, which is what makes the same person on two devices one arrival
   * rather than two.
   */
  uid: string | null;
  presence: 'active' | 'away';
}
