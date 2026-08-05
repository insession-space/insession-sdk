---
"@insession/plugin-watch-party-state": minor
---

`queue-add` accepts a host-supplied `uid`

Queue items got a counter-based id (`q1`, `q2`, ...), which is only safe while the whole queue lives in memory: the counter restarts at zero when a stored queue is reloaded, so restored items and freshly added ones end up sharing ids. A host that persists its queue under its own ids — a database primary key it later uses to delete or reorder — can now pass that id as `uid` and keep storage and state pointed at the same item.

Omitting `uid` keeps the counter-based fallback.
