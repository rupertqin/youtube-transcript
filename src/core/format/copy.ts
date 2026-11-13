import type { CopyTextOptions, LegacyV19 } from '../../legacy/contract';
import type { TranscriptLine } from '../types';

/**
 * 复制文本的唯一实现放在 user-script.js 里（由 sync-legacy.mjs 导出到
 * __yttLegacyV19）。这里只是类型安全的转发层，**不再写第二套规则** ——
 * 原版按钮与新版面板因此永远得到同样的文本。
 *
 * 运行时尚未加载时（单测 / 提前调用）保持原样，不静默套用另一套逻辑。
 */
function shared(): LegacyV19 | null {
  return globalThis.__yttLegacyV19 ?? null;
}

/** 从页面读章节：只认章节面板，不会把字幕面板抽样成章节。 */
export function readChapters(doc: Document): TranscriptLine[] {
  const api = shared();
  if (typeof api?.readChapterRows !== 'function') return [];
  return api.readChapterRows(doc);
}

/** 与原版 Copy Transcript 调用的同一个格式化函数。 */
export function formatCopyText(rows: TranscriptLine[], options: CopyTextOptions = {}): string {
  const api = shared();
  if (typeof api?.formatCopyText !== 'function') return '';
  return api.formatCopyText(rows, options);
}

/**
 * 把行里的无障碍时长短语洗掉，供搜索/渲染/导出复用（返回新数组，不改入参）。
 * 传入 line.start，才能认出「时间码已抽到 start、正文只剩复述」这种形态。
 */
export function cleanLines(lines: TranscriptLine[]): TranscriptLine[] {
  const api = shared();
  if (typeof api?.stripA11yDuration !== 'function') return lines;
  return lines.map((line) => ({ ...line, text: api.stripA11yDuration(line.text, line.start) }));
}
