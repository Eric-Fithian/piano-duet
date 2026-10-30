import starlight from '@astrojs/starlight';
import {defineConfig} from 'astro/config';

const repository = 'https://github.com/Eric-Fithian/piano-duet';

export default defineConfig({
  site: 'https://piano-duet.vercel.app',
  integrations: [
    starlight({
      title: 'Piano Duet',
      description: 'Learn piano with your own acoustic piano and an AI partner that runs entirely on your Mac.',
      logo: {src: './src/assets/logo.svg'},
      favicon: '/favicon.svg',
      social: [{icon: 'github', label: 'GitHub', href: repository}],
      editLink: {baseUrl: `${repository}/edit/main/site/`},
      lastUpdated: true,
      customCss: ['./src/styles/theme.css'],
      head: [
        {tag: 'meta', attrs: {property: 'og:image', content: 'https://piano-duet.vercel.app/og.png'}},
        {tag: 'meta', attrs: {name: 'twitter:card', content: 'summary_large_image'}},
      ],
      sidebar: [
        {label: 'Start here', items: ['start/install', 'start/first-session']},
        {label: 'Modes', items: ['modes/reading', 'modes/drills', 'modes/library', 'modes/practice', 'modes/duet', 'modes/viewing']},
        {label: 'How it works', items: ['how/architecture', 'how/constrained-decoding', 'how/listening', 'how/privacy']},
        {label: 'Contributing', items: ['contributing/development', 'contributing/ci']},
        {label: 'Credits', link: '/credits/'},
      ],
    }),
  ],
});
