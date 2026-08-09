# @insession/space-state

## 0.3.1

### Patch Changes

- cbe9d07: `message-pinned` を受け取ったとき、チャットにログ行を積まなくなった。ピン留めは固定表示そのものが結果を示しているため、ログ行は同じことを繰り返しながら会話を押し上げるだけだった。`pinnedMessage` の更新はこれまでどおり行う。

  これに伴い、core が `log.messagePinned` / `log.messageUnpinned` の2キーを `t` に問い合わせなくなった。消費側で用意していた訳文は削除してよい。

## 0.3.0

### Minor Changes

- dd4a2f9: Make this package readable from outside the project it came from, and give its wire contract a type.

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

## 0.2.2

### Patch Changes

- 1d19e6f: Drop the separate `@insession/space-state-react` package and document the React
  binding here instead.

  `getState` / `subscribe` already satisfy the `useSyncExternalStore` contract, so
  the binding was one line with no logic of its own — and no version of it ever
  carried a change of its own, it only tracked this package's numbering. The README
  now has a **Binding it to React** section with that line, including why no
  `getServerSnapshot` default is shipped.

  Nothing in this package's runtime changed. Consumers of
  `@insession/space-state-react` can keep using the published `0.2.1` or copy the
  hook into their own codebase.

## 0.2.1

### Patch Changes

- f19968e: Rewrite the package READMEs for an external audience. `space-state` and
  `space-state-react` are now in English and documented for readers who have never
  seen InSession: full option and effect tables, a plugin example, and a
  server-free testing example. References that could not be resolved from outside
  this repository (internal issue numbers, private package names, consumer-only
  scripts) are gone. `ws-resilient-transport` keeps its content and only picks up
  the shared heading structure.

## 0.2.0

### Minor Changes

- 197d3aa: InSession 本体（`insession-space/insession-app`）の `packages/space-state` / `packages/space-state-react` から、独立したリポジトリ `insession-space/insession-sdk` へ移設した初版。

  ロジック（`index.ts` / `state.ts` / `reduce.ts` / `actions.ts` / `store.ts` / `plugin.ts` / `effects.ts` / `reactions.ts` / `chat-lines.ts` / `presence.ts` / `types.ts` / `reduce.test.ts`、および `space-state-react/index.ts`）は 1 文字も変えていない。

  `@insession/space-state` は**依存ゼロ**（React・WebSocket・DOM に加えて `@in-session/protocol` にも依存しない。移設元での依存切り離しは insession-app 側の PR #1739 で先行して完了している）。変わったのは配布形式で、これまで InSession 本体の中で `.ts` ソースのまま消費されていたものを、**ビルドした `dist`（`.js` + `.d.ts`）を npm から配る形**にした。副次的に、Node が `node_modules` 配下の `.ts` を型ストリップしない制約からも解放される。

  `@insession/space-state-react` も同様に `dist` 配布へ移行。`@insession/space-state` への依存は `workspace:*`（publish 時に changesets が実バージョンへ書き換える）。
