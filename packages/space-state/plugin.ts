// How an extension teaches the reducer about itself.
//
// The core knows exactly one thing about extension state: store the latest
// value at `apps[appId]`. Everything else an extension might want when its
// state changes — a log line, a sound, a notification, its own previous value
// — lives in a descriptor the extension supplies here. That is what keeps the
// core free of any individual extension's knowledge.
//
// ⚠ `ReduceCtx` is defined here rather than in `reduce.ts`, which re-exports
// it. The other direction would make `reduce.ts` and this module import each
// other.

import type { ChatLineInput } from './chat-lines.ts';
import type { SpaceEffect } from './effects.ts';
import type { AppStateMessage } from './messages.ts';

/** Everything the reducer needs from the consumer to interpret a message. */
export type ReduceCtx = {
  /** This client's own display name. */
  selfName: string;
  /**
   * Resolves a message key to text. Pure — pass an i18n `t` straight in. The
   * reducer never formats user-facing text itself.
   */
  t: (key: string, ...args: any[]) => string;
  /**
   * The current time, injected rather than read. The reducer never calls
   * `Date.now()` itself, so a test can replay a session deterministically.
   */
  now: number;
  /** This client's presence, used to re-declare it after a reconnect. */
  presence: 'active' | 'away';
  /**
   * What to use when a message carries no settings. This package has no idea
   * what settings are, so the consumer supplies the default through
   * `createSpaceStore`'s `initialSettings`.
   */
  defaultSettings: Record<string, unknown>;
  /**
   * The extensions taking part. The core holds no extension-specific logic of
   * its own; only descriptors passed here fold extension state. Omitted means
   * none, which is perfectly valid.
   */
  plugins?: PluginClient[];
};

export type PluginClient = {
  /** Matches the `appId` this extension's messages carry. */
  id: string;
  /**
   * Called on join and on every reconnect. What it returns becomes this
   * extension's private slice (`state.pluginLocal[id]`).
   *
   * ⚠ **Record the value and nothing else.** Deciding something here and
   * emitting an effect for it would fire on every join, including reconnects
   * — announcing a change that nobody made.
   */
  initLocal?: (appState: any) => any;
  /**
   * Called when this extension's state arrives — only for its own `appId`.
   * Storing the new value under `apps[appId]` has already happened, so all
   * that is left is this extension's own slice, its log lines, and its effects.
   */
  onAppState?: (args: { local: any; msg: AppStateMessage; ctx: ReduceCtx }) => {
    local?: any;
    /** Appended in order. */
    lines?: ChatLineInput[];
    effects?: SpaceEffect[];
  };
};

/**
 * Identity function, so a descriptor can be written without a type annotation
 * and still get completion. It returns its argument and nothing else.
 */
export function definePluginClient(c: PluginClient): PluginClient {
  return c;
}
