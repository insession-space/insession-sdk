import { defineConfig } from 'tsup';

// 配布物のビルド。旧モノレポでは .ts ソースをそのまま消費側の Vite / Node ネイティブ型ストリップに
// 解決させていたが、別リポジトリの公開パッケージになったため js + d.ts を生成して配る。
export default defineConfig({
  entry: ['index.ts'],
  // transport/フレームワーク非依存の純粋 TS（React・WebSocket・DOM いずれにも依存しない）。
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
});
