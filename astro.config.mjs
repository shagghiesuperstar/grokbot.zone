import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://grokbot.zone',
  output: 'static',
  trailingSlash: 'always',
  build: { format: 'directory' },
  devToolbar: { enabled: false },
  // The CSS minifier drops -webkit-backdrop-filter for modern targets; iOS before 18 still needs it for the glass.
  vite: { build: { cssTarget: ['safari15', 'chrome100', 'firefox100'] } },
  integrations: [sitemap({ filter: (page) => !page.endsWith('/404/') && !page.endsWith('/bot-template/') })],
});
