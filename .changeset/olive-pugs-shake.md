---
'@insession/space-state': minor
---

Make this package readable from outside the project it came from, and give its wire contract a type.

**The messages it consumes are now declared.** `reduceSpace` took `msg: any`, so the only way to learn what a host has to send was to read every case of the reducer's switch. The new `messages.ts` states it: `SpaceMessage` and one interface per message, each listing the fields the reducer actually reads and allowing whatever else a host attaches. Nothing is validated at runtime — this is a description, not a gate, and an unrecognized `type` is still a no-op.

**`any` in the published types went from 30 to 6.** The six that remain are deliberate: the `t(key, ...args: any[])` i18n signature, and the `PluginClient` slice that this package hands straight back to the extension that owns it.

Type-level changes a consumer may notice (no runtime behavior changed):

- `SpaceState`: `members`/`chatLines`/`title` are now typed; `owner`/`community`/`communityId`/`apps`/`appRelay`/`settings`/`pluginLocal` moved from `any` to `unknown`. Casting `settings` to your own type was already the documented way to read it.
- `SpaceEffect`'s `send` carries the message the reducer actually emits, so it can be read as well as forwarded.
- `PluginClient.onAppState` receives `AppStateMessage`, and `lines` is `ChatLineInput[]`.
- New exported types: `SpaceMessage` and its variants, `SpaceMember`, `ChatLine`/`ChatLineInput`, `ChatReactionsView`, `ReduceResult`, `HostFields`.

**The reducer is split by domain.** One 413-line switch became a dispatcher plus `reduce-space` / `reduce-members` / `reduce-chat` / `reduce-apps` / `reduce-agent`.

**Fixed a broken README example.** The plugin sample compared `msg.phase`, but an extension's state arrives under `msg.state`. `msg.phase` was always `undefined`, so the comparison never held: the sound fired on every message, and the local slice never filled in — the exact failure the surrounding comment warns about. It now reads `msg.state.phase`.

Comments throughout are in English and no longer point at issue numbers, files, or packages that live outside this repository — including a note claiming a verification script that this repository does not have.
