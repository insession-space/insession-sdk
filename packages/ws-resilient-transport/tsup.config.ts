import { defineConfig } from 'tsup';

// 配布物のビルド。旧モノレポでは .ts ソースをそのまま消費側の Vite / Node ネイティブ型ストリップに
// 解決させていたが、別リポジトリの公開パッケージになったため js + d.ts を生成して配る。
export default defineConfig({
  entry: ['index.ts'],
  // ブラウザ WebSocket 前提のクライアントコードだが、Node からも使われる（サーバー側の消費者は
  // `ws` パッケージ等を WebSocket 実装として注入する）。CJS の消費者は想定しないため ESM のみ。
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
});
