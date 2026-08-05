// @ts-check
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

// ⚠ site は Cloudflare Pages の既定ドメイン。独自ドメインを当てたら**ここも変えること**
// （sitemap と canonical URL がこの値から作られるため、古いままだと誤った URL を配る）。
const SITE = 'https://insession-sdk.pages.dev';

export default defineConfig({
  site: SITE,
  integrations: [
    starlight({
      title: '@insession SDK',
      description:
        'Zero-dependency building blocks for realtime shared rooms: a resilient WebSocket transport and a transport-agnostic state store.',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/insession-space/insession-sdk',
        },
      ],
      // ⚠ トークンは @insession/design-system の値を**コピーしている**（依存はしていない）。
      // 理由と同期の手引きは src/styles/tokens.css の先頭コメントを参照。
      customCss: ['./src/styles/tokens.css'],
      editLink: {
        baseUrl: 'https://github.com/insession-space/insession-sdk/edit/main/apps/docs/',
      },
      sidebar: [
        {
          label: 'Start here',
          items: [{ label: 'Getting started', slug: 'getting-started' }],
        },
        {
          label: 'Packages',
          items: [
            { label: 'ws-resilient-transport', slug: 'packages/ws-resilient-transport' },
            { label: 'space-state', slug: 'packages/space-state' },
            { label: 'space-state-react', slug: 'packages/space-state-react' },
            { label: 'pomodoro-state', slug: 'packages/pomodoro-state' },
          ],
        },
      ],
    }),
  ],
});
