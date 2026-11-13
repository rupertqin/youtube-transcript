import type { TranscriptLine } from '../types';
import { stripA11yDuration } from './a11y';
import { readChapterRows } from './chapters';
import { formatTimestamp } from './export';

/**
 * 复制 / 清洗的唯一实现。
 *
 * 面板、导出、搜索都只用这一份，不存在「两套规则对不上」的可能。
 */

export interface CopyTextOptions {
  /** 是否带时间码前缀，默认 true */
  timestamps?: boolean;
  /** 视图：chapters 且有章节时复制章节 */
  view?: 'lines' | 'chapters';
  chapters?: TranscriptLine[];
}

/** 从页面读章节：只认章节面板，不会把字幕面板抽样成章节。 */
export function readChapters(doc: Document): TranscriptLine[] {
  return readChapterRows(doc);
}

/**
 * 面板与导出共用的格式化。
 * `timestamps=false` 时去掉时间码；`view='chapters'` 且有章节时改用章节。
 */
export function formatCopyText(rows: TranscriptLine[], options: CopyTextOptions = {}): string {
  const withTime = options.timestamps !== false;
  const chapters = Array.isArray(options.chapters) ? options.chapters : [];
  const source = options.view === 'chapters' && chapters.length > 0 ? chapters : rows;

  const out: string[] = [];
  for (const row of source) {
    const label = stripA11yDuration(row.text, row.start);
    if (!label) continue;
    out.push(withTime && row.start >= 0 ? `${formatTimestamp(row.start)} ${label}` : label);
  }
  return out.join('\n');
}

/**
 * 把行里的无障碍时长短语洗掉，供搜索/渲染/导出复用（返回新数组，不改入参）。
 * 传入 line.start，才能认出「时间码已抽到 start、正文只剩复述」这种形态。
 */
export function cleanLines(lines: TranscriptLine[]): TranscriptLine[] {
  return lines.map((line) => ({ ...line, text: stripA11yDuration(line.text, line.start) }));
}
