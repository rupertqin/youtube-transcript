import { readFileSync, writeFileSync } from 'node:fs';

/**
 * 「逐步转移」第 1 步：往多了抄。
 *
 * - verbatim.js          —— user-script.js 逐字节副本，用于核对（不 import）
 * - verbatim-runtime.js  —— 同一份内容，只在 IIFE 结束前多一行：
 *                          把原版全部 15 个内部函数挂到 globalThis，
 *                          供新版 dom 层直接调用**原版自己的函数**。
 *   除此之外一字不改：按钮注入、onclick 全流程、SPA setInterval、
 *   setTimeout(addCopyButton, 2000)、copyToClipboard 全部照跑。
 *
 * user-script.js 现在含 2026 面板兼容逻辑（仅内部辅助函数 timecodeToMs /
 * subtitleRows，不导出）。下面 18 项导出名单保持不变，勿把新辅助函数加进去。
 */
const src = readFileSync(new URL('../user-script.js', import.meta.url));
const text = src.toString('utf8');

writeFileSync(new URL('../src/legacy/verbatim.js', import.meta.url), src);

const EXPORT = `
    // [ytt] 唯一新增：暴露原版全部内部函数（逐步转移第 1 步）
    globalThis.__yttLegacyV19 = {
        SEL, sleep, normalize, waitForElement, isVisible, countSegments, pickPanel,
        waitForSegments, openTranscriptPanel, segmentSelectorFor, collectFromList,
        collapseDuplicates, extractTranscript, extractFallback, normalizeLines,
        copyToClipboard, buildButton, addCopyButton
    };
`;

const end = text.lastIndexOf('})();');
if (end < 0) throw new Error('找不到原版 IIFE 结尾');
const runtime = text.slice(0, end) + EXPORT + text.slice(end);

// 校验：除去新增的那一行，与原版逐字节一致
if (runtime.replace(EXPORT, '') !== text) throw new Error('生成结果不是原版逐字节 + 一行导出');
writeFileSync(new URL('../src/legacy/verbatim-runtime.js', import.meta.url), Buffer.from(runtime, 'utf8'));

console.log(`[legacy] 逐字节副本 ${src.length}B；运行时 ${Buffer.byteLength(runtime)}B（仅 +${Buffer.byteLength(EXPORT)}B 导出）`);
