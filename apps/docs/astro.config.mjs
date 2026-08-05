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
        'Zero-dependency building blocks for realtime shared rooms: a resilient WebSocket transport and a transport-agnostic state store.',
      // ⚠ 英語を root locale に置いている（`/` が英語、`/ja/` が日本語）。
      // 既に https://insession-sdk.pages.dev/ が英語で公開済みなので、ここを ja に倒すと
      // **公開済みの URL が全部ずれる**。英語側の URL は変えないこと。
      defaultLocale: 'root',
      locales: {
        root: { label: 'English', lang: 'en' },
        ja: { label: '日本語', lang: 'ja' },
      },
      social: [{ icon: 'github', label: 'GitHub', href: REPO }],
      // ⚠ トークンは @insession/design-system の値を**コピーしている**（依存はしていない）。
      // 理由と同期の手引きは src/styles/tokens.css の先頭コメントを参照。
      customCss: ['./src/styles/tokens.css', './src/styles/examples.css'],
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
            { label: 'ws-resilient-transport', slug: 'packages/ws-resilient-transport' },
            { label: 'space-state', slug: 'packages/space-state' },
            { label: 'chat-state', slug: 'packages/chat-state' },
            { label: 'space-state-react', slug: 'packages/space-state-react' },
            { label: 'plugin-pomodoro-state', slug: 'packages/plugin-pomodoro-state' },
            { label: 'plugin-whiteboard-state', slug: 'packages/plugin-whiteboard-state' },
            { label: 'plugin-watch-party-state', slug: 'packages/plugin-watch-party-state' },
          ],
        },
        {
          label: 'Examples',
          translations: { ja: 'デモ' },
          items: [
            { label: 'pomodoro', slug: 'examples/pomodoro' },
            { label: 'whiteboard', slug: 'examples/whiteboard' },
            { label: 'watch-party', slug: 'examples/watch-party' },
            { label: 'chat', slug: 'examples/chat' },
            { label: 'space-state', slug: 'examples/space-state' },
            { label: 'space-state-react', slug: 'examples/space-state-react' },
          ],
        },
      ],
    }),
    // デモページ(/examples/*)を動かすためだけの統合。ページ本体は MDX のままで、
    // デモのコンポーネントだけを island として載せる。
    react(),
  ],
});
