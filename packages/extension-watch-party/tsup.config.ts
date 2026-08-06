import { defineConfig } from 'tsup';

// 配布物のビルド。旧モノレポでは .ts ソースをそのまま消費側の Node ネイティブ型ストリップに
// 解決させていたが、別リポジトリの公開パッケージになったため js + d.ts を生成して配る。
export default defineConfig({
  entry: ['index.ts'],
  // 消費者である insession-app のサーバーは .ts を直接実行しており require() で読むため、
  // ESM に加えて CJS も出す（ws-resilient-transport と異なりここが唯一の相違点）。
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
});
