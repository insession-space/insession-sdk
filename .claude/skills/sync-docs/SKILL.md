---
name: sync-docs
description: insession-sdk の apps/docs（Astro + Starlight）を英語 README とパッケージ構成に追随させる。英語パッケージページは README から自動生成、日本語ページは手書きという非対称と、translations.lock.json による追随検査、デモ追加時の CSS/ハイドレーションの落とし穴を扱う。
---

# sync-docs — `apps/docs` を追随させる

`apps/docs` は `@insession/*` の外部向けドキュメントサイト兼 LP（Astro + Starlight、`private: true`）。**npm には出ず Changesets の採番対象でもない**ので、`@insession/design-system` に依存してよい**唯一の例外**（`packages/` 配下は従来どおり DS 依存を禁止 — あの規約が守っているのは npm 配布物の依存ゼロ）。

---

## ⚠ まず知っておくこと: 英語は生成、日本語は手書き

| | 英語 `/packages/*` | 日本語 `/ja/packages/*` |
| --- | --- | --- |
| 実体 | `packages/*/README.md` から**自動生成** | `src/content/docs/ja/packages/*.md` を**手書き** |
| 直す場所 | `packages/<name>/README.md` | その `.md` 自体 |
| git | `.gitignore` 済み（`src/content/docs/packages/`） | 追跡される |

**英語パッケージページを手で書かない。** `src/content/docs/packages/` はビルドのたびに `scripts/sync-package-docs.mjs` が作り直すので、編集しても次のビルドで消える。README が単一ソース（README は npm の配布物なので必ず維持され、同じ内容をサイトにも書くと片方だけ直されて静かに食い違う）。

**この非対称がこの構成の唯一の弱点。** README を直すと英語ページだけ更新され、**日本語ページは黙って古くなる**。ビルドは通り続ける。

`/examples/*` は**英語・日本語とも手書き**（`src/content/docs/examples/` と `src/content/docs/ja/examples/`）。

## コマンド

```bash
pnpm --filter @insession/docs run sync         # 生成 + 翻訳追随の検査
pnpm --filter @insession/docs run sync:accept  # 日本語を追随させた後、lock を現在の README のハッシュへ更新
pnpm --filter @insession/docs run dev          # predev が sync と build:deps を自動で走らせる
```

`sync` は `dev` / `build` / `typecheck` の前に自動で走る（`predev` / `prebuild` / `pretypecheck`）ので、手で打つ必要は普段は無い。

### `translations.lock.json`

`scripts/check-translation-sync.mjs` が英語 README の内容ハッシュを控えておき、現在の README と突き合わせる。ずれていたら**警告する**。

- **警告であって失敗にはしない。** ここでビルドを落とすと、英語の修正が日本語の翻訳待ちでブロックされる（英語が正・日本語は追随、という関係を壊さないため）
- **手で編集しない。** 日本語を追随させたら `sync:accept` で更新する
- **警告を `sync:accept` で黙らせるだけにしない。** それは「翻訳した」という嘘の記録になる。日本語ページを実際に直してから accept する

## パッケージを1本足したときにやること

1. **英語ページ** — 何もしない（README から生成される）。ただし README に **h1 が必須**（無いと `sync-package-docs.mjs` が「README に h1 が無い」で落ちる）
2. **日本語ページ** — `src/content/docs/ja/packages/<name>.md` を手で作る。既存7本と同じ構成に揃える
3. **サイドバー** — `astro.config.mjs` の `sidebar` の `Packages` に `{ label: '<name>', slug: 'packages/<name>' }` を足す。足さないとページは存在するのにナビから辿れない
4. **lock** — `pnpm --filter @insession/docs run sync:accept` で新パッケージのハッシュを登録
5. **依存** — デモを作るなら `apps/docs/package.json` に `"@insession/<name>": "workspace:*"` を足す

> ⚠ **空ディレクトリに注意。** パッケージを改名/削除すると、共有チェックアウトには未追跡の `dist` / `node_modules` だけを残した空ディレクトリが居座る（git はコミット済みのファイルしか動かさない）。両スクリプトは `package.json` の有無でパッケージ判定するのでこれは弾かれるが、**「本物のパッケージなのに README が無い」場合は落とす**（README は npm の配布物なので、静かに飛ばしてよい欠落ではない）。

## デモ（`/examples/*`）を足すときにやること

1. `src/components/examples/<Name>Demo.tsx` を作る（既存の `PomodoroDemo.tsx` 等が雛形）
2. `src/content/docs/examples/<name>.mdx` と `src/content/docs/ja/examples/<name>.mdx` を**両方**作る
3. `astro.config.mjs` の `sidebar` の `Examples` に足す。**ja のラベルはページ自身の frontmatter `title` と同じ語にする**（サイドバーと見出しで別の呼び方をすると、同じページが2つあるように読める）

### ⚠ デモ固有の落とし穴

- **デモコンポーネントの中で `import '@insession/design-system/styles.css'` しない。** デモは全て `client:only="react"` なので、island の中で読むとハイドレーション完了までスタイルが当たらず **FOUC** になる。ページの CSS として読む `astro.config.mjs` の `customCss` が唯一の正しい入口
- **`theme.css` / `components.css` を使わない。** あれは Tailwind v4 を持つ消費側専用で、素の `@theme {}` を含む Tailwind ソース。Astro にそのまま食わせても変数が出力されない。Tailwind を持たないこのサイトが読むのは**プリビルド済みの `styles.css` だけ**
- **`src/styles/tokens.css` に色の hex を書き足さない。** 値の正は DS の `--color-*`。ここが持つのは「DS の変数を Starlight の `--sl-color-*` へどう割り当てるか」だけ。新しい色が要るなら DS 側に足す（例外は Starlight が要求するのに DS が持たないグレー4段 + `accent-low` の計8個だけで、そこには `※DS に無い` と印が付いている）
- **`customCss` の順序を並べ替えても DS が勝つことはない。** DS の CSS は全部 `@layer` の中に入るが、Starlight と自前 CSS は layer に属さない。**layer 無しは常に layer 付きより強い**

## `build:deps` を消さない

デモページが `@insession/*` を**実 import** するので、Astro を動かす前に依存パッケージの `dist` が要る。`predev` / `prebuild` / `pretypecheck` が `pnpm --filter "@insession/docs^..." run build`（`^...` は「そのパッケージの依存だけ、自身は含まない」）を走らせている。これが無いと `astro check` が `dist` を解決できずに落ちる。

## `@astrojs/react` は 4 系に留める

Astro 5（Vite 6）に対して 6 系（Vite 7 / rolldown 前提）を入れると `pnpm dev` のハイドレーションが `Missing field moduleType` で落ちる。**`pnpm build` は通り続けるので dev だけが壊れて気づきにくい。**

## 検証

```bash
pnpm --filter @insession/docs run typecheck   # astro check。ルートの pnpm verify が拾う
pnpm --filter @insession/docs run build
```

`typecheck` が `astro check` の名前を持つのは意図的 — ルートの `pnpm typecheck`（`pnpm -r run typecheck`）が自動で拾い、CI の単一ソースである `pnpm verify` に何も足さずに含まれる。

見た目を変えたなら**実際にブラウザで見る**（ライト/ダーク両方、サイドバーのリンク切れ、横スクロールの有無）。

## 停止条件

- [ ] 英語ページを手書きしていない（README を直した）
- [ ] 日本語ページを実際に追随させてから `sync:accept` した
- [ ] `astro.config.mjs` の `sidebar` に登録した
- [ ] `pnpm verify` と `pnpm --filter @insession/docs run build` が**終了コード 0**
