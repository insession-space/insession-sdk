# @insession/space

## 0.2.0

### Minor Changes

- 62c91a7: `reduce` can return `{ effects }` with no state change

  There was no way to say "forward this, but nothing changed". `applyAction` always stored a slice and broadcast it, and `null` meant nothing happened at all — so an extension that wanted to relay something had to invent a state change, which would then persist and broadcast on every frame.

  A live drawing preview is the case this exists for: a frame per pointer move, every one worth forwarding to the other members and none worth keeping.

  ```ts
  reduce(state, action, payload) {
    if (action === 'frame') {
      return { effects: [{ type: 'broadcast', message: { type: 'frame', payload }, excludeSender: true }] };
    }
    ...
  }
  ```

  When a reducer returns effects alone:

  - the effects run, and **nothing else does** — no state broadcast, no persistence
  - **no timer is re-armed.** A timer derived from an unchanged slice is the one already running; re-arming it every frame would reset a countdown that is supposed to run out
  - `applyAction` hands back the **same state object**, so a host can skip its write with `result.state !== before`

  ⚠ This is not `null`. `null` means the action was invalid or a no-op and nothing at all happens; `{ effects }` means something should happen, just not to the state.

  The check is `'state' in result` rather than `state !== undefined`, so an extension whose slice legitimately _is_ `undefined` keeps updating instead of silently freezing.

## 0.1.1

### Patch Changes

- 20b8857: `dedupeByUid` is generic over the caller's member row

  Hosts usually have a richer member row than `SpaceMember` — an avatar, whatever the client is currently looking at, whatever else the lobby renders. Collapsing that list by account should not force it through this package's shape, or push the caller into a cast that quietly erases their own fields from the type.

  `dedupeByUid<T extends DedupableMember>(members: T[]): T[]` reads only `uid` and `presence`, and hands the entries back as they went in — apart from `presence`, which is the one field it may rewrite.

  `DedupableMember` is exported for callers that want to name the constraint.
