/**
 * Conformance: the state machines already published from this repo satisfy
 * `ExtensionServerFacet` as they are.
 *
 * The whole argument for this package is that `plugin-pomodoro-state`,
 * `plugin-whiteboard-state`, `plugin-watch-party-state` and `chat-state` were
 * *already* the same shape, and that `defineSpaceExtension` only gave that
 * shape a name. That claim was checked by reading them. This file checks it by
 * running them: each one is wrapped without an adapter, driven through
 * `createSpace`, and asserted on.
 *
 * ⚠ The imports are **relative paths into the sibling sources**, not package
 * names. Two reasons:
 *
 * 1. A `dependencies` entry would be a runtime dependency, and depending on
 *    the state machines is exactly what this package must not do — it would
 *    make the contract decide which implementations exist.
 * 2. A `devDependencies` entry would resolve through `exports` to `dist`,
 *    so this test would only run after `pnpm build` and would silently check
 *    a stale build. `pnpm verify` does not build. Reading the sources means
 *    drift fails on the next `pnpm verify`, which is the point.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChatState } from '../chat-state/index.ts';
import * as pomodoro from '../plugin-pomodoro-state/index.ts';
import { createWatchParty } from '../plugin-watch-party-state/index.ts';
import { createWhiteboardState } from '../plugin-whiteboard-state/index.ts';
import {
  createSpace,
  defineSpaceExtension,
  type SpaceEffect,
  type SpaceExtension,
} from './index.ts';

// Each of the four is wrapped exactly the way a consumer would: the package's
// own API object handed straight to `server`, with no adapter in between. If
// any of them drifts out of the contract, these four lines stop compiling.
//
// `plugin-pomodoro-state` exports loose functions rather than a factory, so a
// namespace import *is* the facet — which is the strongest form of the claim.
const Pomodoro = defineSpaceExtension({ name: 'pomodoro', server: pomodoro });

const Whiteboard = defineSpaceExtension({
  name: 'whiteboard',
  server: createWhiteboardState({
    isOwnImageUrl: (url) => url.startsWith('https://storage.example.com/'),
  }),
});

const WatchParty = defineSpaceExtension({ name: 'watchParty', server: createWatchParty() });

const Chat = defineSpaceExtension({ name: 'chat', server: createChatState() });

const ALL = [Pomodoro, Whiteboard, WatchParty, Chat] as SpaceExtension[];

function space() {
  return createSpace({ extensions: ALL });
}

const types = (effects: SpaceEffect[]) => effects.map((e) => e.type);
const tagged = (effects: SpaceEffect[]) =>
  effects
    .filter((e): e is Extract<SpaceEffect, { type: 'extension' }> => e.type === 'extension')
    .map((e) => (e.effect as { type: string }).type);

const stroke = {
  id: 's1',
  type: 'freedraw',
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  points: [{ x: 0, y: 0 }],
};

// ── The contract holds ─────────────────────────────────────────────────────

test('all four expose the two required members, and nothing needs an adapter', () => {
  for (const ext of ALL) {
    assert.equal(typeof ext.server?.defaultState, 'function', `${ext.name}: defaultState`);
    assert.equal(typeof ext.server?.reduce, 'function', `${ext.name}: reduce`);
  }
});

test('the optional members are present exactly where each package needs them', () => {
  // Not a style check: `timerDelay`/`onTimer` are what make a Pomodoro phase
  // expire and a relay round end, and their absence elsewhere is why those
  // extensions must still get an explicit `clear-timer`.
  const has = (ext: SpaceExtension, member: string) =>
    typeof (ext.server as unknown as Record<string, unknown>)[member] === 'function';

  assert.equal(has(Pomodoro, 'timerDelay') && has(Pomodoro, 'onTimer'), true, 'pomodoro: timers');
  assert.equal(
    has(Whiteboard, 'timerDelay') && has(Whiteboard, 'onTimer'),
    true,
    'whiteboard: relay phase timers',
  );
  assert.equal(has(WatchParty, 'timerDelay'), false, 'watch party: playback needs no server timer');
  assert.equal(has(Chat, 'timerDelay'), false, 'chat: no timers');

  for (const ext of ALL) assert.equal(has(ext, 'restore'), true, `${ext.name}: restore`);
  // Only the Pomodoro carries session-only state (who is participating).
  assert.equal(has(Pomodoro, 'persistState'), true);
});

test('all four coexist in one space, each owning its own namespaced slice', () => {
  const s = space();
  assert.deepEqual(Object.keys(s.getState().extensions).sort(), [
    'chat',
    'pomodoro',
    'watchParty',
    'whiteboard',
  ]);
  // Each slice is exactly what its own package would have produced alone.
  assert.deepEqual(s.getState().extensions.pomodoro, pomodoro.defaultState());
  assert.deepEqual(s.getState().extensions.chat, Chat.server?.defaultState());
});

// ── Each one, driven through createSpace ───────────────────────────────────

test('pomodoro: a bare-state reducer broadcasts and arms its own timer', () => {
  const s = space();
  const effects = s.dispatch('pomodoro', 'start');
  assert.deepEqual(types(effects), ['broadcast', 'schedule-timer']);

  const state = s.getState().extensions.pomodoro as pomodoro.PomodoroState;
  assert.equal(state.running, true);
  // The delay comes from the package's own timerDelay, not from this package.
  const armed = effects.at(-1) as Extract<SpaceEffect, { type: 'schedule-timer' }>;
  assert.ok(armed.delayMs > 0 && armed.delayMs <= state.config.work * 1000);
});

test('pomodoro: firing the timer advances the phase and re-arms', () => {
  const s = space();
  s.dispatch('pomodoro', 'start');
  const before = (s.getState().extensions.pomodoro as pomodoro.PomodoroState).phase;

  const fired = s.fireTimer('pomodoro');
  const after = (s.getState().extensions.pomodoro as pomodoro.PomodoroState).phase;
  assert.notEqual(after, before, 'work -> break');
  assert.deepEqual(types(fired), ['broadcast', 'schedule-timer'], 'still running, so re-armed');
});

test('pomodoro: persistState drops session-only participants on the way to storage', () => {
  const s = space();
  s.dispatch('pomodoro', 'join', { by: 'Ada', uid: 'u1' });
  assert.deepEqual(
    Object.keys((s.getState().extensions.pomodoro as pomodoro.PomodoroState).participants),
    ['Ada'],
    'present in memory',
  );
  const stored = s.snapshot().pomodoro as pomodoro.PomodoroState;
  assert.deepEqual(Object.keys(stored.participants), [], 'absent from storage');
});

test('whiteboard: a plain action broadcasts and clears, having no timer pending', () => {
  const s = space();
  assert.deepEqual(types(s.dispatch('whiteboard', 'add-stroke', { stroke })), [
    'broadcast',
    'clear-timer',
  ]);
});

test('whiteboard: the host-injected URL predicate still decides, through the wrapper', () => {
  // Reaching the one action that consults `isOwnImageUrl` takes a real relay
  // game — asserting the rejection from the lobby would pass for the wrong
  // reason, since `submit-drawing` is refused outside the draw phase whatever
  // the URL is.
  const s = space();
  s.dispatch('whiteboard', 'set-mode', { mode: 'relay' });
  s.dispatch('whiteboard', 'join-game', { by: 'Ada' });
  s.dispatch('whiteboard', 'join-game', { by: 'Bob' });
  s.dispatch('whiteboard', 'start-game', { by: 'Ada' });
  s.dispatch('whiteboard', 'submit-prompt', { by: 'Ada', text: 'a cat' });
  s.dispatch('whiteboard', 'submit-prompt', { by: 'Bob', text: 'a hat' });

  const game = (s.getState().extensions.whiteboard as { game: { phase: string } }).game;
  assert.equal(game.phase, 'draw', 'the game really is in the phase that checks URLs');

  assert.deepEqual(
    s.dispatch('whiteboard', 'submit-drawing', {
      by: 'Ada',
      imageUrl: 'https://evil.example.com/x.png',
    }),
    [],
    'a foreign URL is refused, and refusal surfaces as "nothing happened", not an error',
  );
  assert.deepEqual(
    types(
      s.dispatch('whiteboard', 'submit-drawing', {
        by: 'Ada',
        imageUrl: 'https://storage.example.com/ok.png',
      }),
    ),
    ['broadcast', 'schedule-timer'],
    "the host's own URL is accepted, and the round's deadline is armed",
  );
});

test('whiteboard: an unknown action is a no-op, not a crash', () => {
  assert.deepEqual(space().dispatch('whiteboard', 'not-an-action'), []);
});

test('watch party: an effect-returning reducer has its own effects tagged', () => {
  const s = space();
  const effects = s.dispatch('watchParty', 'load-video', {
    videoId: 'zyxwvutsrqp',
    by: 'Ada',
  });

  assert.equal(effects[0].type, 'broadcast', 'the state broadcast comes first');
  assert.deepEqual(effects.at(-1), { type: 'clear-timer', extension: 'watchParty' });
  // Its domain effects arrive wrapped, so a host can tell whose they are —
  // `persist-playback` here would otherwise be indistinguishable from any
  // other extension's persistence effect.
  assert.ok(tagged(effects).includes('persist-playback'), tagged(effects).join(','));
  for (const e of effects) {
    if (e.type === 'extension') assert.equal(e.extension, 'watchParty');
  }
});

test('chat: core message effects pass through unwrapped', () => {
  const s = space();
  const effects = s.dispatch('chat', 'chat', { text: 'hello', by: 'Ada', uid: 'u1' });

  assert.equal(effects[0].type, 'broadcast');
  // `persist-chat` is domain-specific and gets tagged...
  assert.ok(tagged(effects).includes('persist-chat'), tagged(effects).join(','));
  // ...but `broadcast`/`send-to-sender` are the shared vocabulary and are not
  // wrapped, which is the whole reason they were made core.
  assert.equal(
    effects.every((e) => e.type !== 'extension' || e.extension === 'chat'),
    true,
  );
});

// ── Storage round-trip across all four ─────────────────────────────────────

test('snapshot and hydrate round-trip every package at once', () => {
  const s = space();
  s.dispatch('pomodoro', 'start');
  s.dispatch('whiteboard', 'add-stroke', { stroke });
  s.dispatch('watchParty', 'load-video', { videoId: 'zyxwvutsrqp', by: 'Ada' });
  s.dispatch('chat', 'pin-message', { messageId: 7, by: 'Ada' });

  const stored = JSON.parse(JSON.stringify(s.snapshot()));

  const fresh = space();
  fresh.hydrate(stored);
  const after = fresh.getState().extensions;

  // Each package's own `restore` decides what survives. Both timer-bearing
  // packages deliberately come back stopped rather than resuming a countdown
  // against a clock that is no longer valid, so the re-armed timers are
  // `clear-timer` — which is exactly what a host needs after a restart.
  assert.equal((after.pomodoro as pomodoro.PomodoroState).running, false);
  assert.deepEqual(
    fresh.armTimers().map((e) => e.type),
    ['clear-timer', 'clear-timer', 'clear-timer', 'clear-timer'],
  );
  // What is genuinely persistent does come back.
  assert.equal((after.whiteboard as { strokes: unknown[] }).strokes.length, 1);
});

test('a slice belonging to an extension this host does not run is left alone', () => {
  // Two hosts on different extension lists must not destroy each other's
  // stored state — the same guarantee, now across real packages.
  const partial = createSpace({ extensions: [Chat] });
  partial.hydrate({ chat: { pinnedMessage: null }, pomodoro: { phase: 'break' } });
  assert.deepEqual(partial.snapshot().pomodoro, { phase: 'break' });
});
