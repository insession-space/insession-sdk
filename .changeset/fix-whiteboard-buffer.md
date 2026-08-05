---
"@insession/plugin-whiteboard-state": patch
---

Fix `ReferenceError: Buffer is not defined` in browsers

The shape byte cap used Node's `Buffer.byteLength`, so `add-shape` and `update-shape` threw in any browser — `0.1.0` is unusable client-side. It now uses `TextEncoder`, which exists in both runtimes and counts the same UTF-8 bytes (verified across multi-byte text, emoji and lone surrogates), so the cap itself is unchanged.

A regression test now asserts that the source reaches for no Node-only globals. This class of bug is invisible to Node-side tests, which is exactly how it shipped: it only surfaced when the package was loaded in a real browser.
