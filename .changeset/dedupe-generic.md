---
'@insession/space': patch
---

`dedupeByUid` is generic over the caller's member row

Hosts usually have a richer member row than `SpaceMember` — an avatar, whatever the client is currently looking at, whatever else the lobby renders. Collapsing that list by account should not force it through this package's shape, or push the caller into a cast that quietly erases their own fields from the type.

`dedupeByUid<T extends DedupableMember>(members: T[]): T[]` reads only `uid` and `presence`, and hands the entries back as they went in — apart from `presence`, which is the one field it may rewrite.

`DedupableMember` is exported for callers that want to name the constraint.
