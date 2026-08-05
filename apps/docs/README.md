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

## ⚠ 色は design-system の「値」をコピーしている（依存はしていない）

`src/styles/tokens.css` が `@insession/design-system` のトークンを写経して Starlight の
テーマ変数へ流している。**DS をパッケージとして依存していない** — このリポジトリは
「契約とランタイム」だけを置く方針で、サイトの見た目のためだけに SDK → DS の依存を作ると、
UI プリミティブを直すたびに 3リポジトリ往復が生まれる（ルート `CLAUDE.md` 参照）。

**DS のブランド色を変えてもここは自動追従しない。** 同期するときは design-system の
`src/styles/theme.css` を正として突き合わせること。

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
