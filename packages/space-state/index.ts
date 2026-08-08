// @insession/space-state — a transport-agnostic, framework-agnostic store for
// the state of a synchronized space.
//
// Received messages go through a pure reducer; outgoing messages go to a
// handler you supply; side effects (sound, notification, timer, send) come
// back as descriptors for you to carry out. Nothing here opens a socket,
// touches storage, or renders anything.
//
//   messages.ts       — the wire contract this store consumes
//   state.ts          — the state tree and its initial value
//   types.ts          — the few server-owned shapes the reducer reads into
//   chat-lines.ts     — what a transcript line is, and the one way to add one
//   effects.ts        — the side effects the reducer asks for
//   plugin.ts         — how an extension teaches the reducer about itself
//   presence.ts       — one person, however many devices
//   reactions.ts      — the server's reaction summary, per viewer
//   reduce*.ts        — the reducer, dispatched to one module per domain
//   actions.ts        — transitions that don't come from a message
//   store.ts          — the store that ties it together

export * from './actions.ts';
// Types only: `pushChatLine` is the internal single point where a line gets
// its key and the transcript is trimmed. Consumers add lines through
// `addChatLine` (or the store method of the same name), which is the same
// thing with a name that says why you are calling it.
export type { ChatLine, ChatLineInput, ChatLogLine, ChatMessageLine } from './chat-lines.ts';
export * from './effects.ts';
export * from './messages.ts';
export * from './plugin.ts';
export * from './presence.ts';
export * from './reactions.ts';
export * from './reduce.ts';
export * from './state.ts';
export * from './store.ts';
export * from './types.ts';
