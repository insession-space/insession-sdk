import { defineConfig } from 'tsup';

// 配布物のビルド。旧モノレポでは .ts ソースをそのまま消費側の Vite ネイティブ解決に任せていたが、
// 別リポジトリの公開パッケージになったため js + d.ts を生成して配る。
export default defineConfig({
  entry: ['index.ts'],
  // React の useSyncExternalStore だけを使う薄いラッパー。JSX は持たない。
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ['react'],
});
