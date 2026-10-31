import starlight from '@astrojs/starlight';
import {defineConfig} from 'astro/config';

const repository = 'https://github.com/Eric-Fithian/piano-duet';

export default defineConfig({
  site: 'https://piano-duet.vercel.app',
  base: '/docs',
  outDir: './dist/docs',
  vite: {server: {headers: {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  }}},
  integrations: [
    starlight({
      title: 'Piano Duet',
      description: 'Learn piano with your own acoustic piano and an AI partner that runs entirely on your Mac.',
      logo: {light: './src/assets/logo.svg', dark: './src/assets/logo-dark.svg'},
      favicon: '/favicon.svg',
      social: [{icon: 'github', label: 'GitHub', href: repository}],
      editLink: {baseUrl: `${repository}/edit/main/site/`},
      lastUpdated: true,
      customCss: ['./src/styles/theme.css'],
      head: [
        {tag: 'link', attrs: {rel: 'alternate icon', href: '/docs/favicon.ico'}},
        {tag: 'link', attrs: {rel: 'apple-touch-icon', href: '/docs/apple-touch-icon.png'}},
        {tag: 'link', attrs: {rel: 'manifest', href: '/docs/brand/manifest.webmanifest'}},
        {tag: 'meta', attrs: {name: 'theme-color', content: '#f5f1e8', media: '(prefers-color-scheme: light)'}},
        {tag: 'meta', attrs: {name: 'theme-color', content: '#14211a', media: '(prefers-color-scheme: dark)'}},
        {tag: 'meta', attrs: {property: 'og:image', content: 'https://piano-duet.vercel.app/docs/og.png'}},
        {tag: 'meta', attrs: {name: 'twitter:card', content: 'summary_large_image'}},
        {tag: 'meta', attrs: {name: 'twitter:image', content: 'https://piano-duet.vercel.app/docs/og.png'}},
      ],
      sidebar: [
        {label: 'Start here', items: ['start/install', 'start/first-session']},
        {label: 'Modes', items: ['modes/reading', 'modes/drills', 'modes/library', 'modes/viewing']},
        {label: 'How it works', items: ['how/architecture', 'how/constrained-decoding', 'how/listening', 'how/performance', 'how/privacy']},
        {label: 'Contributing', items: ['contributing/development', 'contributing/ci']},
        {label: 'Credits', link: '/credits/'},
      ],
    }),
  ],
});
