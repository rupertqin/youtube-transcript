import { deepQueryAll } from '../dom/shadow';
import { parseTimecode } from '../dom/text-rows';
import type { TranscriptLine } from '../types';
import { stripA11yDuration } from './a11y';

/**
 * 从页面读章节。
 *
 * 只认「章节面板」。绝不能写 `[visibility*="EXPANDED"]` —— 那块正是字幕面板，
 * 字幕行间隔几秒，按 30s 抽样后也能凑出十几行，会被误当章节。
 * 真实 dump 里章节面板是 `target-id="engagement-panel-macro-markers-description-chapters"`。
 *
 * 解析规则只有一份：章节视图、复制、导出共用。
 */

const CHAPTER_PANELS = [
  'ytd-engagement-panel-section-list-renderer[target-id*="chapter"]',
  'ytd-engagement-panel-section-list-renderer[target-id*="macro-markers"]',
  '[target-id*="macro-markers"]',
  'ytd-macro-markers-list-item-renderer',
].join(',');

/** 章节条目自身的容器：面板认不出时，把所有条目文本拼起来再切。 */
const CHAPTER_ITEMS = [
  'ytd-macro-markers-list-item-renderer',
  'yt-macro-markers-list-item-view-model',
  '[class*="macro-markers-list-item"]',
].join(',');

const MIN_GAP_MS = 30_000;
const MAX_ROWS = 80;

/** normalize：合并空白、去掉零宽字符 */
function tidy(input: string): string {
  return input
    .replace(/\u200b/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** 按时间码切分，剥掉无障碍时长；去重、按时间递增。 */
export function parseChapters(text: string): TranscriptLine[] {
  const parts = stripA11yDuration(text).split(/\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*/u);
  const seen = new Set<number>();
  const out: TranscriptLine[] = [];

  for (let i = 1; i < parts.length; i += 2) {
    const start = parseTimecode(parts[i]);
    const label = tidy(parts[i + 1] ?? '');
    if (start === null || !label || label.length > 200 || seen.has(start)) continue;
    seen.add(start);
    out.push({ start, dur: 0, text: label });
  }

  return out.sort((a, b) => a.start - b.start);
}

/**
 * 从一段面板文本里切章节。
 *
 * 防「字幕被当成章节」的判据：字幕每隔几秒一行，按 30s 抽样后间隔会**整齐地
 * 堆在 30s 附近**（每次都是「越过阈值后的第一行」）。真实章节的间隔是分钟级
 * 且参差不齐。所以间隔里 ≥70% 落在 30~40s 就判定为字幕抽样并丢弃。
 */
function parseChapterList(raw: string): TranscriptLine[] {
  const kept: TranscriptLine[] = [];
  for (const row of parseChapters(raw)) {
    if (kept.length === 0 || row.start - kept[kept.length - 1].start >= MIN_GAP_MS) kept.push(row);
  }
  if (kept.length < 2 || kept.length > MAX_ROWS) return [];

  const gaps: number[] = [];
  for (let i = 1; i < kept.length; i += 1) gaps.push(kept[i].start - kept[i - 1].start);
  const sampled = gaps.filter((gap) => gap >= 30_000 && gap <= 40_000).length;
  if (gaps.length >= 3 && sampled / gaps.length >= 0.7) return [];
  return kept;
}

function readText(el: Element): string {
  const node = el as HTMLElement;
  return node.innerText || node.textContent || '';
}

export function readChapterRows(doc: Document): TranscriptLine[] {
  if (!doc || typeof doc.querySelectorAll !== 'function') return [];
  try {
    // ① 整块章节面板（innerText 一次读完，顺序天然正确）
    for (const el of deepQueryAll(doc, CHAPTER_PANELS).slice(0, 16)) {
      const raw = readText(el);
      if (!raw || raw.length > 20_000) continue;
      const rows = parseChapterList(raw);
      if (rows.length > 0) return rows;
    }

    // ② 面板结构变了（只剩条目节点）：按 DOM 顺序把条目文本拼起来
    const items = deepQueryAll(doc, CHAPTER_ITEMS).slice(0, 120);
    if (items.length >= 2) {
      const rows = parseChapterList(items.map((el) => tidy(readText(el))).join('\n'));
      if (rows.length > 0) return rows;
    }
  } catch {
    /* 读取失败就当没有章节 */
  }
  return [];
}
