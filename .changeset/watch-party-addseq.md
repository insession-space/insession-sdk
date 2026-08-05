---
"@insession/plugin-watch-party-state": minor
---

`queue-add` accepts a host-supplied `addSeq`

A host that awaits anything before calling `reduce` — looking up a duration to enforce a cap, fetching a title — can now stamp arrival order itself and pass it as `addSeq`. Without it, `reduce` assigned the ordering number at call time, which records *landing* order: two adds sent back to back swapped places whenever the second one's lookup resolved first, and the queue no longer matched what people sent.

Omitting `addSeq` keeps the previous behaviour, which is still correct for hosts that never await before reducing.
