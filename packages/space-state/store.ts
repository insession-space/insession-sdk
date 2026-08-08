// The store: state in one place, a reducer for what arrives, plain functions
// for what this client does, and no I/O of its own.
//
// Receiving goes through `reduceSpace`. Sending goes to whoever subscribed
// with `onSend`. Effects go to whoever subscribed with `onEffect`, and are
// never executed here. `getState`/`subscribe` satisfy `useSyncExternalStore`
// as they are, which is why this package ships no React binding of its own —
// see the README.

import {
  addChatLine,
  appendLocalChat,
  clearTyping,
  expireAgentStatus,
  resetConnection,
  toggleReactionLocally,
} from './actions.ts';
import type { ChatLineInput } from './chat-lines.ts';
import type { SpaceEffect } from './effects.ts';
import type { SpaceMessage } from './messages.ts';
import type { PluginClient, ReduceCtx } from './plugin.ts';
import { reduceSpace } from './reduce.ts';
import { initialSpaceState, type SpaceState } from './state.ts';

/**
 * Correlates a locally echoed message with the ack that carries its id.
 * Falls back for environments without `crypto.randomUUID` (a page served over
 * plain HTTP, for instance).
 */
function defaultGenClientMsgId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export type SpaceStoreOptions = {
  selfName: string;
  /** Resolves a message key to text. Pure — pass an i18n `t` straight in. */
  t: (key: string, ...args: any[]) => string;
  getPresence: () => 'active' | 'away';
  /** Defaults to `Date.now`. Injected so a test can pin it. */
  now?: () => number;
  genClientMsgId?: () => string;
  /** The extensions taking part. Omitted means none. */
  plugins?: PluginClient[];
  /**
   * The value `settings` starts at, and falls back to when a message carries
   * none. This package has no idea what settings are, so the consumer supplies
   * its own default here.
   */
  initialSettings?: Record<string, unknown>;
};

export type SpaceStore = ReturnType<typeof createSpaceStore>;

export function createSpaceStore(opts: SpaceStoreOptions) {
  const initialSettings = opts.initialSettings ?? {};
  let state = initialSpaceState(initialSettings);
  // `selfName` and `t` can be replaced later — changing the interface language
  // must not require tearing down the connection — so they are held as
  // mutable variables rather than read out of `opts` each time.
  let selfName = opts.selfName;
  let t = opts.t;
  const getPresence = opts.getPresence;
  const now = opts.now ?? Date.now;
  const genClientMsgId = opts.genClientMsgId ?? defaultGenClientMsgId;
  const plugins = opts.plugins ?? [];

  const listeners = new Set<() => void>();
  const sendHandlers = new Set<(msg: unknown) => void>();
  const effectHandlers = new Set<(e: SpaceEffect) => void>();

  /** Throttles the typing notice to one per second. */
  let lastTypingSentAt = 0;

  function getState(): SpaceState {
    return state;
  }

  /** `useSyncExternalStore` contract: same reference until something changes. */
  function setState(next: SpaceState) {
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  }

  function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function onSend(fn: (msg: unknown) => void) {
    sendHandlers.add(fn);
    return () => sendHandlers.delete(fn);
  }

  function onEffect(fn: (e: SpaceEffect) => void) {
    effectHandlers.add(fn);
    return () => effectHandlers.delete(fn);
  }

  /** Hands a message to the transport. Nothing is inspected on the way out. */
  function send(msg: unknown) {
    for (const fn of sendHandlers) fn(msg);
  }

  /**
   * Puts a received message through the reducer, applies the new state, and
   * hands out the effects.
   *
   * `msg` is typed loosely on purpose: what arrives is whatever came off the
   * wire, and the reducer already treats an unrecognized `type` as a no-op.
   */
  function receive(msg: SpaceMessage | Record<string, unknown>) {
    const ctx: ReduceCtx = {
      selfName,
      t,
      now: now(),
      presence: getPresence(),
      plugins,
      defaultSettings: initialSettings,
    };
    const { state: next, effects } = reduceSpace(state, msg as SpaceMessage, ctx);
    setState(next);
    for (const effect of effects) {
      for (const fn of effectHandlers) fn(effect);
    }
  }

  return {
    getState,
    subscribe,
    receive,
    onSend,
    onEffect,
    send,

    chat: {
      /**
       * Sends a message and shows it immediately, rather than waiting for it
       * to come back — the server broadcasts to everyone except the sender.
       * The `clientMsgId` is what the server's ack comes back with, carrying
       * the storage id that reactions and replies need. Until then the line
       * has `id: null`, so a reaction control has nothing to attach to.
       */
      send(text: string, replyTo?: { id: number; name: string; text: string }) {
        const clientMsgId = genClientMsgId();
        send({ type: 'chat', text, clientMsgId, replyToId: replyTo?.id ?? null });
        // The local echo deliberately carries no avatar: this client is by
        // definition present, so the consumer can resolve it from the member
        // list. Keeping it out avoids pulling one application's notion of
        // "my avatar" into a general-purpose store.
        setState(
          appendLocalChat(state, {
            kind: 'chat',
            name: selfName,
            self: true,
            text,
            id: null,
            clientMsgId,
            reactions: {},
            replyTo: replyTo ?? undefined,
            createdAt: now(),
          }),
        );
      },

      /**
       * Sends an image sticker. `imageUrl` must already be somewhere the other
       * members can fetch it from — uploading is the consumer's business.
       * Echoed locally for the same reason as `send`.
       */
      sendSticker(imageUrl: string) {
        const clientMsgId = genClientMsgId();
        send({ type: 'chat', text: '', clientMsgId, kind: 'sticker', imageUrl });
        setState(
          appendLocalChat(state, {
            kind: 'chat',
            name: selfName,
            self: true,
            text: '',
            id: null,
            clientMsgId,
            reactions: {},
            imageUrl,
            createdAt: now(),
          }),
        );
      },

      /**
       * Toggles a reaction, optimistically. A message with no id yet (its ack
       * hasn't arrived) can't be reacted to, so the call is dropped.
       */
      react(messageId: number | null, emoji: string) {
        if (!messageId) return;
        send({ type: 'chat-reaction', messageId, emoji });
        setState(toggleReactionLocally(state, messageId, emoji, selfName));
      },

      /**
       * Pins a message, or unpins with `null`. The server broadcasts the
       * result and is what keeps "at most one" true; this side only asks.
       */
      pin(messageId: number | null) {
        send({ type: 'pin-message', messageId });
      },

      /**
       * Says this client is typing. Safe to call on every keystroke — repeats
       * within a second are dropped here rather than put on the wire.
       */
      typing() {
        const t0 = now();
        if (t0 - lastTypingSentAt < 1000) return;
        lastTypingSentAt = t0;
        send({ type: 'typing' });
      },
    },

    settings: {
      update(patch: unknown) {
        send({ type: 'update-space-settings', settings: patch });
      },
    },

    presence: {
      change(p: 'active' | 'away') {
        send({ type: 'presence-change', presence: p });
      },
    },

    /**
     * Tells the server which card this client has open. The server relays it
     * to everyone, including back to this client.
     */
    stage: {
      change(stage: string | null) {
        send({ type: 'stage-change', stage });
      },
    },

    /** Adds a line the consumer composed itself. */
    addChatLine(line: ChatLineInput) {
      setState(addChatLine(state, line));
    },

    /** Called when the per-name typing timer fires. */
    clearTyping(name: string) {
      setState(clearTyping(state, name));
    },

    /** Called when an agent run's backstop timer fires. */
    expireAgentStatus(agentId: string, requestId: string) {
      setState(expireAgentStatus(state, agentId, requestId));
    },

    reset() {
      setState(resetConnection(state));
    },

    /** Replaceable without reconnecting — see the note in `createSpaceStore`. */
    setT(next: (key: string, ...args: any[]) => string) {
      t = next;
    },
    setSelfName(next: string) {
      selfName = next;
    },
  };
}
