---
'@insession/extension-watch-party': patch
---

Accept every playable Spotify content kind, not just podcast episodes.

`isValidMediaId` only matched `spotify-episode-<id>`, so a host that also
offers music sent `spotify-track-<id>` (and `album`/`playlist` for pasted
URLs) and `queue-add`/`load-video` returned `null` for all of them — no queue
entry, and no `queue-rejected` either, since `null` means "nothing happened"
rather than "refused". The id shape is now
`spotify-(track|album|playlist|episode)-<22 base62 chars>`, a strict superset
of what shipped before, so already-persisted episode ids keep validating.
`show` stays out on purpose: a show is a series, not something playable.
