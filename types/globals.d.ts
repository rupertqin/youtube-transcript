/** 构建时由 vite.userscript.config.ts / wxt.config.ts 注入，跟 package.json 的 version 同步。 */
declare const __YTT_VERSION__: string;

/** 由 scripts/sync-legacy.mjs 从 user-script.js 逐字节同步的纯 JS 脚本（副作用导入）。 */
declare module '*/verbatim.js';
declare module '*/verbatim-runtime.js';
