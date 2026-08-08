// @ts-check
import react from '@astrojs/react';
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

// ⚠ site は Cloudflare Pages の既定ドメイン。独自ドメインを当てたら**ここも変えること**
// （sitemap と canonical URL がこの値から作られるため、古いままだと誤った URL を配る）。
const SITE = 'https://insession-sdk.pages.dev';

const REPO = 'https://github.com/insession-space/insession-sdk';

export default defineConfig({
  site: SITE,
  integrations: [
    starlight({
      title: {
        en: '@insession SDK',
        ja: '@insession SDK',
      },
      description:
        'Building blocks for realtime shared rooms: an extension engine that assembles them into one space, a resilient WebSocket transport, and a transport-agnostic state store.',
      // ⚠ ロゴは**ライト/ダークで別ファイル**。文字色が違うだけの2枚で、片方だけを指定すると
      // 反対のテーマで文字が地に沈んで読めなくなる（暗い版は #F1EEE6 の白文字）。
      //
      // ⚠ `replacesTitle: true` にすると、ヘッダーからテキストの `title` が消えてロゴだけになる。
      // ただし `title` は**消さずに残すこと** — `<title>` タグ・OGP・検索結果はこの値を使い続けるし、
      // ロゴ画像の alt にも使われる。
      logo: {
        light: './src/assets/logo-sdk-light.png',
        dark: './src/assets/logo-sdk-dark.png',
        replacesTitle: true,
      },
      // ⚠ 英語を root locale に置いている（`/` が英語、`/ja/` が日本語）。
      // 既に https://insession-sdk.pages.dev/ が英語で公開済みなので、ここを ja に倒すと
      // **公開済みの URL が全部ずれる**。英語側の URL は変えないこと。
      defaultLocale: 'root',
      locales: {
        root: { label: 'English', lang: 'en' },
        ja: { label: '日本語', lang: 'ja' },
      },
      social: [{ icon: 'github', label: 'GitHub', href: REPO }],
      // ⚠ **順序に意味がある。** DS を先頭に置き、後続2枚がそれを上書きできるようにする。
      //
      // DS の CSS は全部 `@layer`（theme / base / components / utilities）の中に入るが、
      // Starlight のスタイルと下の2枚は layer に属さない。**layer 無しは常に layer 付きより強い**ので、
      // 実際の優先順位は「Starlight と自前 CSS > DS」になる。並べ替えても DS が勝つことはない。
      //
      // ⚠ **デモコンポーネントの中で `import '@insession/design-system/styles.css'` しないこと。**
      // デモは全て `client:only="react"` なので、island の中で読むとハイドレーション完了まで
      // スタイルが当たらず FOUC になる。ページの CSS として読むここが唯一の正しい入口。
      //
      // ⚠ `theme.css` / `components.css` は**使わない**。あれは Tailwind v4 を持つ消費側専用で、
      // 素の `@theme {}` を含む Tailwind ソースなので、Astro にそのまま食わせても変数が出力されない。
      // Tailwind を持たないこのサイトが読むべきなのはプリビルド済みの `styles.css` だけ。
      //
      // 内訳: DS（トークンの値）→ tokens（Starlight 変数への橋渡し）→ site（サイト全体の意匠）
      // → examples（デモページ固有）。**後ろほど強い**ので、固有のものを後ろに置く。
      customCss: [
        '@insession/design-system/styles.css',
        './src/styles/tokens.css',
        './src/styles/site.css',
        './src/styles/examples.css',
      ],
      editLink: { baseUrl: `${REPO}/edit/main/apps/docs/` },
      sidebar: [
        {
          label: 'Start here',
          translations: { ja: 'はじめに' },
          items: [
            {
              label: 'Getting started',
              translations: { ja: 'はじめかた' },
              slug: 'getting-started',
            },
          ],
        },
        {
          label: 'Packages',
          translations: { ja: 'パッケージ' },
          items: [
            // 親パッケージなので先頭。ここから extension を組み立てる。
            { label: 'space', slug: 'packages/space' },
            { label: 'ws-resilient-transport', slug: 'packages/ws-resilient-transport' },
            { label: 'space-state', slug: 'packages/space-state' },
            { label: 'extension-chat', slug: 'packages/extension-chat' },
            { label: 'extension-pomodoro', slug: 'packages/extension-pomodoro' },
            { label: 'extension-whiteboard', slug: 'packages/extension-whiteboard' },
            { label: 'extension-watch-party', slug: 'packages/extension-watch-party' },
          ],
        },
        {
          label: 'Examples',
          translations: { ja: 'デモ' },
          items: [
            {
              label: 'the whole space',
              translations: { ja: 'スペース全体' },
              slug: 'examples/space',
            },
            { label: 'pomodoro', translations: { ja: 'ポモドーロ' }, slug: 'examples/pomodoro' },
            {
              label: 'whiteboard',
              translations: { ja: 'ホワイトボード' },
              slug: 'examples/whiteboard',
            },
            {
              label: 'watch-party',
              translations: { ja: 'ウォッチパーティー' },
              slug: 'examples/watch-party',
            },
            { label: 'chat', translations: { ja: 'チャット' }, slug: 'examples/chat' },
            {
              // ⚠ ja のラベルはページ自身の frontmatter `title` と同じ語にすること。
              // サイドバーと見出しで別の呼び方をすると、同じページが2つあるように読める。
              label: 'space-state',
              translations: { ja: 'スペースの状態' },
              slug: 'examples/space-state',
            },
            {
              label: 'React binding',
              translations: { ja: 'React バインディング' },
              slug: 'examples/react-binding',
            },
          ],
        },
      ],
    }),
    // デモページ(/examples/*)を動かすためだけの統合。ページ本体は MDX のままで、
    // デモのコンポーネントだけを island として載せる。
    react(),
  ],
});
