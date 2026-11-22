import { defineConfig, type Plugin } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

/**
 * Tampermonkey 产物：单文件 IIFE，meta 头由构建生成，版本号跟随 package.json。
 * 与扩展端共用 src/core + src/ui，唯一差别是这里不拆 world（脚本本身跑在页面上下文）。
 */
const meta = `// ==UserScript==
// @name         YouTube Transcript Studio
// @namespace    https://github.com/youtube-transcript-studio
// @version      ${pkg.version}
// @description  Extract, search and export transcripts from YouTube and Bilibili.
// @match        https://www.youtube.com/*
// @match        https://www.bilibili.com/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==
`;

/** rolldown 下 output.banner 不稳定，统一在 generateBundle 里塞 meta 头 */
function userscriptBanner(text: string): Plugin {
  return {
    name: 'ytt-userscript-banner',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type === 'chunk') output.code = `${text}\n${output.code}`;
      }
    },
  };
}

export default defineConfig({
  plugins: [tailwindcss(), userscriptBanner(meta)],
  publicDir: false,
  define: {
    'process.env.NODE_ENV': '"production"',
    __YTT_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: 'dist/userscript',
    emptyOutDir: true,
    target: 'chrome111',
    cssCodeSplit: false,
    minify: true,
    lib: {
      entry: 'userscript/main.ts',
      name: 'YouTubeTranscriptStudio',
      formats: ['iife'],
      fileName: () => 'youtube-transcript.user.js',
    },
  },
});
