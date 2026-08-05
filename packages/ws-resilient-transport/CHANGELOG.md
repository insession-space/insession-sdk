# @insession/ws-resilient-transport

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

- f27da24: InSession 本体（`insession-space/insession-app`）の `packages/ws-resilient-transport` から、独立したリポジトリ `insession-space/insession-sdk` へ移設した初版。

  ロジック（`index.ts` / `index.test.ts`）は 1 文字も変えていない。変わったのは配布形式で、これまで InSession 本体の中で `.ts` ソースのまま消費されていたものを、**ビルドした `dist`（`.js` + `.d.ts`）を npm から配る形**にした。副次的に、Node が `node_modules` 配下の `.ts` を型ストリップしない制約（サーバー側の消費者が symlink 回避を強いられる）からも解放される。
