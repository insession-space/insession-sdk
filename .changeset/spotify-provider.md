---
'@insession/extension-watch-party': minor
---

Add a `spotify` provider

Episodes from Spotify can now be loaded and queued, alongside YouTube, SoundCloud
and podcasts. Their ids use the `spotify-episode-<22 base62 chars>` shape, and —
like SoundCloud and podcast items — they carry a `mediaUrl` through sanitization.

Note Spotify's `mediaUrl` is the episode's public page URL, kept for display and
outbound links: unlike SoundCloud/podcast it is not the stream the player
consumes (Spotify's own embed resolves that from the id).

Without this, a host that adds a `spotify` provider on its side only hits the
same silent failure the `podcast` provider hit before it was supported here: an
unrecognized provider string falls through to the YouTube branch, so the id never
matches YouTube's 11-char shape and every `load-video`/`queue-add` is discarded —
the client reports success while the queue stays empty.
