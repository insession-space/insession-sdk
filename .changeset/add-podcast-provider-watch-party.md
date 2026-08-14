---
"@insession/extension-watch-party": patch
---

Add `'podcast'` as a recognized `WatchPartyProvider`, alongside `'youtube'` and `'soundcloud'`. Podcast episodes are treated the same as SoundCloud: an external-URL provider that requires `mediaUrl` and validates ids against a `podcast-<8 hex>-<8 hex>` pseudo-id format (matching the consuming app's own id shape) instead of YouTube's 11-char videoId format.

Before this change, `providerOf`/`isValidMediaId` only knew `'youtube'` and `'soundcloud'` — any other provider string (including `'podcast'`) silently fell through to the YouTube branch, so a podcast episode's `queue-add`/`load-video` was always rejected as an invalid videoId with no error surfaced to the sender.
