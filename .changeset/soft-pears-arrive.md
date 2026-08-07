---
'@insession/extension-pomodoro': patch
'@insession/extension-whiteboard': patch
'@insession/extension-watch-party': patch
'@insession/extension-chat': patch
---

Fix README code examples that were still written against the pre-effects API,
and drop the historical rename notices.

`reduce`/`onTimer` return `{ state, effects } | null`, but the Usage blocks in
`extension-pomodoro` and `extension-whiteboard` still assigned the result
straight to `state` — which contradicted the API tables in the same files.
Whiteboard's example also ignored the effects-only result shape used by the
live relay frames. Both now show the real shape, including a `runEffect` helper
that matches what the Effects section describes.
