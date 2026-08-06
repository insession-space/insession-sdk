# @insession/docs

`@insession/*` の外部向けドキュメントサイト兼 LP。Astro + Starlight の静的サイトで、
**npm には publish しない**（`private: true`）。

## 動かす

```bash
pnpm --filter @insession/docs dev      # http://localhost:4321
pnpm --filter @insession/docs build    # dist/ に静的出力
pnpm --filter @insession/docs preview  # ビルド結果を確認
```

ルートの `pnpm verify` / `pnpm build` からも回る（`typecheck` は `astro check`）。

## ⚠ パッケージページは README から生成している。ここを直しても消える

`/packages/*` の各ページは、`packages/<name>/README.md` から
`scripts/sync-package-docs.mjs` が**ビルドのたびに生成**する。

```
packages/space-state/README.md  ──生成──>  src/content/docs/packages/space-state.md
```

**パッケージのドキュメントの正は README。** README は `package.json` の `files` に入っていて
npm のパッケージページにそのまま出る配布物なので、どのみち維持される。同じ内容をサイト側にも
手で書くと片方だけ直されて静かに食い違い、しかも「どちらが正か」が誰にも分からなくなる。

- 生成物（`src/content/docs/packages/`）は `.gitignore` 済み。**編集しても次のビルドで消える**
- 直すときは `packages/<name>/README.md` を直す
- 各ページの "Edit page" リンクは生成物ではなく**元の README** を指している
- パッケージを足すと、ページも sidebar 用の slug も自動では増えない。
  **`astro.config.mjs` の `sidebar` に項目を足すこと**（ページ自体は自動生成される）

トップページ（`src/content/docs/index.mdx`）と Getting started は手書き。

## 日本語版（`/ja/`）

英語が root locale（`/`）、日本語が `/ja/`。**英語側の URL は変えないこと** — 既に公開済みで、
外部からリンクされうる。

| 言語 | URL | 置き場所 | 作り方 |
| --- | --- | --- | --- |
| 英語 | `/` | `src/content/docs/` | トップと Getting started は手書き、`packages/*` は README から**生成** |
| 日本語 | `/ja/` | `src/content/docs/ja/` | **すべて手書き** |

日本語ページを `packages/*/README.ja.md` から生成しない理由は、**README が npm の配布物**
だから。npm は世界向けの窓口なので英語1本に保ち、`files` にも手を入れない。日本語は
「サイトの都合」なのでサイト側（`apps/docs`）に閉じ込めてある。

### ⚠ この非対称が唯一の弱点 — 同期ずれは機械で検知する

英語は生成・日本語は手書きなので、**README を直すと英語ページだけ更新され、日本語ページは
黙って古くなる**。ビルドは通り続けるので、検査しない限り誰も気づけない。

`scripts/check-translation-sync.mjs` が、英語 README の内容ハッシュを `translations.lock.json`
と突き合わせて警告する。`sync` に組み込んであるので `dev` / `build` / `typecheck` のたびに走る。

```
⚠ 日本語ページが英語 README から取り残されている可能性があります:
  - space-state  7b8037d6aa405272 → 620a33e6c8ebaa55
```

**警告であってビルド失敗にはしない。** ここで落とすと、英語の修正が日本語の翻訳待ちで
ブロックされる。英語が正・日本語は追随、という関係を壊さないため。

翻訳を追随させたら lock を更新する:

```bash
pnpm --filter @insession/docs run sync:accept
```

`translations.lock.json` はこのスクリプトが管理する。**手で編集しない。**

### 日本語ページを足すとき

- 各日本語ページの冒頭に「**英語版が正**」の `:::note` を置く（食い違ったときの拠り所を明示するため）
- sidebar のラベルは `astro.config.mjs` の `translations: { ja: '…' }` で訳す
- **コード例・API 名・オプション名は訳さない**。訳すと英語版と突き合わせられなくなる

## デモページ（`/examples/*`）

各パッケージを**ブラウザ上で実際に動かす**ページ。英語 `src/content/docs/examples/`・日本語
`src/content/docs/ja/examples/` のどちらも**手書き**（`packages/*` と違って生成物ではない）。
デモ本体は `src/components/examples/*.tsx` の React コンポーネントで、**英日で同じものを共有**
している（説明文だけ訳し、ボタン等の UI ラベルは英語のまま）。

- **デモはパッケージの実装を実際に import する。** 挙動を再実装しないこと — デモが独自の状態機械を
  持つと、パッケージを直したときにデモだけ静かに古くなる
- ページに載せるときは `client:only="react"` を使う。`client:load` だと SSR 時に
  `useSpaceState`（`getServerSnapshot` を渡さない `useSyncExternalStore`）が落ちる
- パッケージを足してデモを作ったら、`astro.config.mjs` の `sidebar` の Examples にも項目を足すこと

### ⚠ デモは依存パッケージの `dist` を要求する

デモが `@insession/*` を実 import するので、Astro を動かす前に依存パッケージがビルド済みで
なければならない。`dev` / `build` / `typecheck` の前に `build:deps`（`pnpm --filter
"@insession/docs^..." run build`）を挟んであるのはそのため。

**特に CI は `pnpm verify`（`typecheck` を含む）を `pnpm build` より先に回す。** これが無いと
`astro check` が `dist` を解決できずに落ちる。

### ⚠ `@astrojs/react` は 4 系に留めること

Astro 5（Vite 6）に対して 6 系を入れると、`pnpm dev` でハイドレーションが落ちる
（`builtin:vite-react-refresh-wrapper` の `Missing field 'moduleType'` — 6 系は Vite 7 / rolldown
前提）。**厄介なのは `pnpm build` が通り続けること**で、dev だけが壊れるため気づきにくい。
`pnpm add @astrojs/react` を無指定で打つと最新（6 系）が入るので、上げるときは Astro 本体の
メジャーと合っているかを先に確かめること。

## ⚠ このサイトは `@insession/design-system` に依存している（色のコピーはもう持たない）

以前ここは DS のトークンを `src/styles/tokens.css` に**手で写経**していた。デモを DS の
プリミティブで組むことにした時点（#53）で写経は割に合わなくなり、**npm 公開版への依存**に
切り替えた。部品（`Button` / `Lozenge` / `MessageItem` …）を使う以上、部品が参照する変数は
DS のものでなければならず、値だけ写しても同じ色を2箇所で管理する状態が増えるだけになる。

**依存を持ち込むのは `apps/docs` だけ。`packages/` 配下は従来どおり禁止**（あそこだけが npm に
出る配布物で、「依存ゼロ」がそのパッケージを選ぶ理由そのもの）。詳しい判断はルート `CLAUDE.md`
の「例外: `apps/docs` は `@insession/design-system` に依存してよい」を参照。

取り込みで踏むと壊れる点が4つある:

1. **CSS は `astro.config.mjs` の `customCss` からだけ読む。** デモは全て `client:only="react"`
   なので、コンポーネント内で `import '@insession/design-system/styles.css'` すると
   ハイドレーション完了までスタイルが当たらず **FOUC** になる。
2. **`customCss` の順序に意味がある**（DS → `tokens.css` → `examples.css`）。DS の CSS は
   `@layer` の中、こちらは layer 無しで、**layer 無しは常に layer 付きより強い**。
3. **`theme.css` / `components.css` は使わない。** あれは Tailwind v4 を持つ消費側専用で、
   素の `@theme {}` を含む Tailwind ソース。Tailwind を持たないこのサイトが読むべきなのは
   プリビルド済みの `styles.css` だけ（消費側に Tailwind は要らない）。
4. **デモのルート要素の `className="demo not-content"` を外さないこと。** `not-content` は
   Starlight の markdown スタイルを無効化するためのもので、外すと DS の部品が壊れる。

`tokens.css` が今持っているのは「DS の `--color-*` を Starlight の `--sl-color-*` へどう
割り当てるか」だけで、**色の値は持たない**。新しい色が要るなら DS 側に足すこと。

`accent`（塗り専用）と `accent-soft`（文字用）の役割を混ぜないこと。ライトの `accent`
(`#ff2f02`) は文字として使うとコントラスト基準を満たさない。

## デプロイ（Cloudflare Pages）

**Cloudflare Pages の Git 連携を使う。GitHub Actions からはデプロイしない。**

理由: Actions からデプロイするには Cloudflare の API トークンを GitHub Secrets に置く必要が
あるが、**このリポジトリは「長期の認証情報を1つも持たない」ことを意図して維持している**
（npm publish も OIDC で、トークンを使っていない。ルート `CLAUDE.md` の「シークレット」参照）。
静的サイトを配るためだけにその性質を崩す価値は無い。Pages の Git 連携なら
Cloudflare 側が GitHub App で認証するので、リポジトリに秘密が増えない。

Cloudflare Pages 側に設定する値:

| 項目 | 値 |
| --- | --- |
| Production branch | `main` |
| Framework preset | Astro（または None） |
| Build command | `corepack enable && pnpm install --frozen-lockfile && pnpm --filter @insession/docs run build` |
| Build output directory | `apps/docs/dist` |
| Root directory | （リポジトリルートのまま。空欄） |
| 環境変数 `NODE_VERSION` | `22` |

- **Build output はリポジトリルートからの相対**。`apps/docs/dist` と書くこと（`dist` だと空振りする）
- pnpm workspace なのでルートで install する必要がある。`Root directory` を `apps/docs` にすると
  workspace の解決に失敗する
- **独自ドメインを当てたら `astro.config.mjs` の `site` も変えること。** sitemap と canonical URL が
  この値から作られるので、既定の `*.pages.dev` のままだと誤った URL を配る
