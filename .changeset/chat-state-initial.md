---
'@insession/chat-state': minor
---

Add `@insession/chat-state`, a dependency-free, server-authoritative chat state machine: message normalization, sticker validation, replies, per-message emoji reactions, a typing indicator and a pinned message.

Ported from the server-side chat handlers of InSession — the pure decision-making only, with no UI, i18n, or design-system dependency. Like `plugin-watch-party-state`, `reduce` returns `{ state, effects }` rather than performing I/O, so persistence, broadcasting and bot notification stay with the host. Three flows need a value only storage can produce (the persisted message id, a re-counted reaction aggregate, a looked-up message), and each is split across two `reduce` calls rather than making `reduce` async. The one genuinely external decision — whether a sticker URL is allowed into the room — needs I/O in every real host, so it arrives as a host-resolved `stickerAllowed` boolean instead of an injected predicate. Ships both ESM and CJS builds so hosts that `require()` it keep working.
