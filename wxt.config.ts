import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

export default defineConfig({
  outDir: 'dist',
  outDirTemplate: 'extension',
  manifest: {
    name: 'YouTube Transcript Studio',
    description:
      'Extract, search and export YouTube transcripts. Works from the side panel or an in-page overlay.',
    permissions: ['storage', 'sidePanel'],
    host_permissions: ['https://www.youtube.com/*'],
    action: {
      default_title: 'YouTube Transcript Studio',
      default_icon: {
        16: 'icon/16.png',
        32: 'icon/32.png',
        48: 'icon/48.png',
        128: 'icon/128.png',
      },
    },
    icons: {
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      128: 'icon/128.png',
    },
  },
  vite: () => ({
    define: { __YTT_VERSION__: JSON.stringify(pkg.version) },
    plugins: [tailwindcss()],
    build: {
      target: 'chrome111',
    },
  }),
});
