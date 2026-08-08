---
'@insession/extension-watch-party': patch
'@insession/extension-whiteboard': patch
'@insession/extension-pomodoro': patch
'@insession/extension-chat': patch
---

Split each state machine's single `index.ts` into modules (`types` / `sanitize` / `state` / `reduce` / `extension`, plus `relay` for whiteboard, `playback` for watch party, `persist` for pomodoro). `index.ts` is now nothing but the package's public surface.

No behavior change and no API change: every exported symbol and its type signature is identical, and the existing tests pass unmodified against the same entry point.
