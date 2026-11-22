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
    name: 'Transcript Studio',
    description:
      'Extract, search and export transcripts from supported video sites. Works from the side panel or an in-page card.',
    permissions: ['storage', 'sidePanel'],
    host_permissions: [
      'https://www.youtube.com/*',
      // B 站：页面本身 + 字幕接口（api.bilibili.com 带登录态请求，靠 host 权限拿 CORS 豁免）
      'https://www.bilibili.com/*',
      'https://api.bilibili.com/*',
      // 字幕正文在 CDN 上，域名会变，只列已知的几个
      'https://aisubtitle.hdslb.com/*',
      'https://i0.hdslb.com/*',
      'https://i1.hdslb.com/*',
    ],
    action: {
      default_title: 'Transcript Studio',
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
    define: { __TRANSCRIPT_STUDIO_VERSION__: JSON.stringify(pkg.version) },
    plugins: [tailwindcss()],
    build: {
      target: 'chrome111',
    },
  }),
});
