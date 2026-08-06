/**
 * `@insession/space` — build a headless realtime space out of extensions.
 *
 * You bring your own WebSocket server and your own storage. This package owns
 * what sits between them: who is in the room, which extension owns which
 * slice of its state, how an action reaches the right reducer, when a timer
 * needs re-arming, and what goes to storage and comes back.
 *
 * Nothing here performs I/O. Every transition returns *effect descriptors*
 * and the host runs them, which is what lets the same space run on a `ws`
 * server, a Durable Object, or a test with no network at all.
 *
 * Zero dependencies.
 */
export * from './effects.ts';
export * from './extension.ts';
export * from './registry.ts';
export * from './room.ts';
export * from './space.ts';
