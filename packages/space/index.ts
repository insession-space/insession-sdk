/**
 * `@insession/space` — build a headless realtime space out of extensions.
 *
 * You bring your own WebSocket server and your own storage. This package owns
 * what sits between them: who is connected, which extension owns which slice
 * of state, how an action reaches the right reducer, when a timer needs
 * re-arming, and what goes to storage and comes back.
 *
 * Nothing here performs I/O. Every transition returns *effect descriptors*
 * and the host runs them, which is what lets the same space run on a `ws`
 * server, a Durable Object, or a test with no network at all.
 *
 * ## Layout
 *
 * - `effects` — the vocabulary both halves share
 * - `extension/` — what a space can do: the contract and its registry
 * - `members/` — who is in it: the connection list, presence, and the
 *   "new person or second device?" judgment
 * - `create-space` — where the two are composed
 *
 * Zero dependencies.
 */
export * from './create-space.ts';
export * from './effects.ts';
export * from './extension/index.ts';
export * from './members/index.ts';
