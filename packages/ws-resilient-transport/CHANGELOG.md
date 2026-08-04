# @insession/ws-resilient-transport

## 0.2.0

### Minor Changes

- f27da24: InSession 本体（`insession-space/insession-app`）の `packages/ws-resilient-transport` から、独立したリポジトリ `insession-space/insession-sdk` へ移設した初版。

  ロジック（`index.ts` / `index.test.ts`）は 1 文字も変えていない。変わったのは配布形式で、これまで InSession 本体の中で `.ts` ソースのまま消費されていたものを、**ビルドした `dist`（`.js` + `.d.ts`）を npm から配る形**にした。副次的に、Node が `node_modules` 配下の `.ts` を型ストリップしない制約（サーバー側の消費者が symlink 回避を強いられる）からも解放される。
