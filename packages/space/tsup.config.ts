import { defineConfig } from 'tsup';

// 配布物のビルド。js + d.ts を生成して配る（.ts ソースは配らない）。
export default defineConfig({
  entry: ['index.ts'],
  // 消費者である insession-app のサーバーは .ts を直接実行しており require() で読むため、
  // ESM に加えて CJS も出す（plugin-*-state / chat-state と同じ理由）。
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
});
