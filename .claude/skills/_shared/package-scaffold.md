# 共通規約: `packages/` に新しいパッケージを足すときの雛形

`create-extension` と `add-package` が共有する手順。**同じ内容をスキル側に書き写さないこと**（二重管理になり、片方だけ古くなる）。

雛形の原本は **`packages/ws-resilient-transport`**（ESM only の最小構成）。CJS も要るなら `packages/extension-pomodoro` を見る。

---

## 1. ディレクトリを作る

```
packages/<name>/
  index.ts          # エントリ。tsup の entry もこれ
  index.test.ts     # node --test で走る
  package.json
  tsconfig.json
  tsup.config.ts
  README.md         # 英語。npm の配布物（下記）
  LICENSE           # MIT。既存パッケージからコピー
```

`pnpm-workspace.yaml` は `packages/*` を拾うので**追記不要**。`CHANGELOG.md` は Changesets が採番時に自動生成するので手で作らない。

## 2. `package.json`

`packages/ws-resilient-transport/package.json` をコピーして名前・説明・keywords・`repository.directory` を差し替える。**触ってはいけないフィールド**:

| フィールド | 消すと何が起きるか |
| --- | --- |
| `publishConfig.registry` | 開発機の `~/.npmrc` が社内プロキシを `registry` に向けていると、publish がプロキシ宛になり**公開レジストリに出ない** |
| `publishConfig.access: "public"` | スコープ付きパッケージは既定が restricted。有料組織でないと publish が落ちる |
| `scripts.prepublishOnly` (`npm run build`) | ビルドせずに publish され、`dist` が空のまま出る（→ `publish-package` スキル） |
| `files` | `dist` / `README.md` / `LICENSE` / `CHANGELOG.md` の4つ。README は**配布物**なのでここから外さない |

`scripts` は4つで足りる: `build`（`tsup`）/ `test`（`node --test`）/ `typecheck`（`tsc --noEmit -p tsconfig.json`）/ `prepublishOnly`。ルートの `typecheck` / `test` / `build` は `pnpm -r run <同名>` で各パッケージのこれらを呼ぶだけなので、**名前を変えると静かに検査から漏れる**（`check` だけはルートで `biome check .` を1回走らせる形なのでパッケージ側に要らない）。

**`version` は `0.1.0` 始まり**（`ws-resilient-transport` の初版がこれ。以降は Changesets が上げる）。旧名からの改名で作るパッケージだけは例外で、旧版の続きから始める（`extension-*` の4本がそう）。

### ESM only か、CJS も出すか

- **ESM only**（`ws-resilient-transport`）— ブラウザ/バンドラ経由の消費者しか居ない場合
- **ESM + CJS**（`extension-*` 全部）— 消費者である `insession-app` のサーバーが**ビルドせず `.ts` を直接実行**していて `require()` で読むため。ESM only にすると `require` が壊れる

CJS も出すなら `exports` を `import` / `require` の二段にし、`main` と `types` を足す（`extension-pomodoro/package.json` がそのまま雛形）。`tsup.config.ts` の `format` も `['esm', 'cjs']` にする。

## 3. `tsconfig.json` / `tsup.config.ts`

- `tsconfig.json` は `../../tsconfig.base.json` を extends し、`lib` だけ変える。**DOM を使わないパッケージに `"DOM"` を入れない**（純粋な状態機械が `window` を触れてしまう）
- `tsc` は**型検査専用（`noEmit`）**。配布物を作るのは tsup。ここを混ぜない
- `tsup.config.ts` は `entry: ['index.ts']` / `dts: true` / `sourcemap: true` / `clean: true`

## 4. 依存ゼロを守る

**`dependencies` を足さない。** 「依存ゼロ」が `packages/` 配下のパッケージを選ぶ理由そのもの（CLAUDE.md）。`devDependencies` は `tsup` と `typescript` の2つだけ。

外部の知識が要るときの解き方は `create-extension` スキルの「外部依存の解き方3パターン」を参照（extension 以外でも同じ判断でよい）。

## 5. 相対 import は拡張子 `.ts` を明示

```ts
import { reduce } from './reduce.ts';   // ✅
import { reduce } from './reduce';      // ❌
```

## 6. README は英語で書く（配布物）

`files` に入っていて **npm のパッケージページにそのまま出る**。加えて `apps/docs` の英語パッケージページが**この README から生成される**（`sync-docs` スキル参照）。したがって:

- **英語**で書く。見出し構成とトーンを既存パッケージに揃える（`# <名前>` → フック段落 → `## Install` → `## Usage` → `## API` → `### Types` → `## Test` → `## License`。extension なら `## Drop it into a space` を Install の直後に置く）
- **h1 が必須**（`sync-package-docs.mjs` が h1 をページタイトルに使い、無いと docs のビルドが落ちる）。h1 の次の段落が `<meta description>` になるので、そこに一番言いたいことを書く
- **リポジトリ外を参照しない** — 社内 Issue 番号、private リポジトリのパッケージ名やシンボル（`@in-session/*` 等）、消費側にしか無いスクリプト。外部読者には解決できない
- **コード例は実際に動かして確かめる**（過去に `effect.kind` で分岐する例が載っていたが、実際の判別子は `effect.type` だった）

## 7. テストを書く

`node --test` が `*.test.ts` を拾う（Node のネイティブ型ストリップで `.ts` のまま走る）。`node:assert/strict` を使う。既存パッケージのテストが書き方の雛形。

## 8. 検証する

```bash
pnpm verify   # typecheck + biome + test。CI と同じ判定の単一ソース
pnpm build    # 全パッケージの dist を生成
```

**緑かどうかは終了コードで判定する。** 出力を眺めて「エラーが無さそう」で緑にしない。

> ⚠ `.claude/worktrees/` に他のブランチのチェックアウトが居ると、以前は biome がそちらの `biome.json` を拾って `pnpm verify` がローカルだけ落ちた。今は `.gitignore` の `.claude/*` で除外されている（`biome.json` の `vcs.useIgnoreFile: true` が効く）。**この除外を消さないこと。**

## 9. changeset を積む

```bash
pnpm changeset
```

新規パッケージなら `minor`。**積み忘れると version が上がらず publish も起きない**うえ、このリポジトリの CI には `changeset-required` ジョブが**無い**ので PR は赤くならない。自分で気づくしかない。

## 10. docs と publish

- docs（`apps/docs`）の追従 → **`sync-docs` スキル**
- 初回 publish（新規パッケージは手動が要る）→ **`publish-package` スキル**

## 11. 名前の禁則

- **`space-core` を使わない。** `insession-app` に `@in-session/space-core`（React・UI 込み・private）が実在し、ハイフン1つしか違わないのに責務が正反対。しかも `insession-app` では両方が同時にインストールされる
- `extension-` 接頭辞は「`@insession/space` に載る出荷物である」ことを示す。状態機械でないものに付けない
