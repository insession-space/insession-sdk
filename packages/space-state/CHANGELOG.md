# @insession/space-state

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
