# @insession/extension-chat

## 0.2.2

### Patch Changes

- 38bb35d: Fix README code examples that were still written against the pre-effects API,
  and drop the historical rename notices.

  `reduce`/`onTimer` return `{ state, effects } | null`, but the Usage blocks in
  `extension-pomodoro` and `extension-whiteboard` still assigned the result
  straight to `state` — which contradicted the API tables in the same files.
  Whiteboard's example also ignored the effects-only result shape used by the
  live relay frames. Both now show the real shape, including a `runEffect` helper
  that matches what the Effects section describes.

> Renamed from `@insession/chat-state` at 0.2.0. Entries below 0.2.0 were published under the old name.

## 0.1.0

### Minor Changes

- 0d404a9: Add `@insession/chat-state`, a dependency-free, server-authoritative chat state machine: message normalization, sticker validation, replies, per-message emoji reactions, a typing indicator and a pinned message.

  Ported from the server-side chat handlers of InSession — the pure decision-making only, with no UI, i18n, or design-system dependency. Like `plugin-watch-party-state`, `reduce` returns `{ state, effects }` rather than performing I/O, so persistence, broadcasting and bot notification stay with the host. Three flows need a value only storage can produce (the persisted message id, a re-counted reaction aggregate, a looked-up message), and each is split across two `reduce` calls rather than making `reduce` async. The one genuinely external decision — whether a sticker URL is allowed into the room — needs I/O in every real host, so it arrives as a host-resolved `stickerAllowed` boolean instead of an injected predicate. Ships both ESM and CJS builds so hosts that `require()` it keep working.
