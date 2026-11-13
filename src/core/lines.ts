import type { TranscriptLine } from './types';

export function hasTimestamps(lines: TranscriptLine[]): boolean {
  return lines.some((line) => line.start >= 0);
}

/**
 * 字幕是否装得进这条视频。
 *
 * 一条字幕的最后时间点不可能晚于视频结束。这条判据**与 videoId 无关**，
 * 所以能抓出「id 对得上、内容却是别的视频」的脏数据 —— 早期版本在 SPA 切页
 * 窗口期把上一页的字幕按新视频的 id 写进了缓存，单看 videoId 永远查不出来。
 *
 * 留 60s 容差：ASR 末条常常略微超过片长。
 */
export function transcriptFitsDuration(
  lines: TranscriptLine[],
  durationSeconds: number | null,
): boolean {
  if (!durationSeconds || durationSeconds <= 0 || lines.length === 0) return true;
  const last = lines[lines.length - 1]?.start ?? 0;
  return last <= durationSeconds * 1000 + 60_000;
}

/** 二分定位当前播放行：1000+ 行时不要每帧全表扫。 */
export function findActiveIndex(lines: TranscriptLine[], seconds: number): number {
  if (lines.length === 0) return -1;
  const ms = Math.max(0, seconds * 1000);
  let low = 0;
  let high = lines.length - 1;
  let best = -1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lines[mid].start <= ms) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best;
}

/**
 * 章节高亮：真实播放位置落在哪个章节区间。
 *
 * 必须传**真实位置**（positionMs），不能传「当前字幕行的 start」——
 * 章节 28:14 对应的那条字幕行可能是 28:09，用行起点比较会永远命中上一章。
 */
export function findChapterIndex(chapters: TranscriptLine[], positionMs: number): number {
  if (chapters.length === 0 || positionMs < 0) return -1;
  let low = 0;
  let high = chapters.length - 1;
  let best = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (chapters[mid].start <= positionMs) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

export function totalDuration(lines: TranscriptLine[]): number {
  if (lines.length === 0) return 0;
  const last = lines[lines.length - 1];
  return Math.max(0, last.start + last.dur);
}

/** 播放列表、推荐位、页脚这些装饰词一旦占多数，就说明读到的不是字幕。 */
const PAGE_CHROME_RE = /(订阅|subscriber|观看|views\b|\bago\b|comments?|watching|推荐|分享|share)/iu;

/**
 * 兜底文本/缓存有可能来自「面板外的页面区域」（推荐列表也带 30:24 这种时长徽标）。
 * 命中页面装饰词过半就拒收 —— 宁可重抓，也不能把推荐列表当字幕。
 */
export function looksLikeTranscript(lines: TranscriptLine[]): boolean {
  // 真实字幕不可能只有一两行；1 行往往是面板标题（Transcript）被当成了内容
  if (lines.length < 3) return false;
  const chrome = lines.filter((line) => PAGE_CHROME_RE.test(line.text)).length;
  if (chrome / lines.length >= 0.35) return false;

  // 章节列表（28:14 → 33:04 → 34:23…）相邻隔几分钟；字幕相邻行通常几秒。
  // 挡住把 Chapters 时间点当成字幕写进缓存的情况。
  const times = lines
    .map((line) => line.start)
    .filter((start) => start > 0)
    .sort((a, b) => a - b);
  if (times.length >= 3) {
    let wide = 0;
    for (let i = 1; i < times.length; i += 1) {
      if (times[i] - times[i - 1] > 45_000) wide += 1;
    }
    if (wide / (times.length - 1) > 0.6) return false;
  }
  return true;
}

/* ---------------- 句子级合并 ---------------- */

/**
 * 把 2–4 秒的 ASR 碎片拼成可读的段落。
 *
 * YouTube 原生面板显示的不是原始分段：它把连续若干段合成一条，只在段落开头
 * 留一个时间码。我们一直把 `get_transcript` 返回的每个 `transcriptSegmentRenderer`
 * 单独渲染成一行，于是同一份数据看起来「特别散」，行数甚至是原生的 4–5 倍。
 *
 * 合并判据按原生面板的实际形态取值：
 * - 相邻间隔 ≤ 8s（台词之间的停顿；章节之间隔几分钟，自然切开）
 * - 合并后 ≤ 140 字符、跨度 ≤ 12s（避免滚成一整块）
 * - `[CHEERING, APPLAUSE]` 这种音效/舞台提示独立成行
 * - 中文边界不补空格，英文边界补一个空格
 *
 * 保留首段 `start`（点击跳转、播放高亮都靠它），并把 `dur` 重算成
 * 「末段结束 − 首段开始」—— SRT 导出用 `dur` 算结束时间，缺了会缩到第一段。
 * O(n) 单次遍历。
 */
const MERGE_MAX_CHARS = 140;
const MERGE_MAX_SPAN_MS = 12_000;
const MERGE_MAX_GAP_MS = 8_000;
const SOUND_CUE_RE = /^\[[^\]]{1,40}\]$/u;
const CJK_RE = /[\u3400-\u9fff\u3040-\u30ff\uf900-\ufaff]/u;

export interface MergeOptions {
  maxChars?: number;
  maxSpanMs?: number;
  maxGapMs?: number;
}

/** 拼接两段正文：中文之间不留空格，英文之间补一个。 */
function joinText(left: string, right: string): string {
  const a = left.trimEnd();
  const b = right.trimStart();
  if (!a) return b;
  if (!b) return a;
  const needsSpace = !CJK_RE.test(a.slice(-1)) && !CJK_RE.test(b[0]);
  return needsSpace ? `${a} ${b}` : `${a}${b}`;
}

export function mergeFragments(
  lines: readonly TranscriptLine[],
  options: MergeOptions = {},
): TranscriptLine[] {
  const maxChars = options.maxChars ?? MERGE_MAX_CHARS;
  const maxSpanMs = options.maxSpanMs ?? MERGE_MAX_SPAN_MS;
  const maxGapMs = options.maxGapMs ?? MERGE_MAX_GAP_MS;

  const out: TranscriptLine[] = [];
  for (const line of lines) {
    const cur: TranscriptLine = { ...line };
    const prev = out[out.length - 1];

    // 没有时间码、或音效提示：不参与合并
    if (
      !prev ||
      prev.start < 0 ||
      cur.start < 0 ||
      SOUND_CUE_RE.test(prev.text.trim()) ||
      SOUND_CUE_RE.test(cur.text.trim())
    ) {
      out.push(cur);
      continue;
    }

    const prevEnd = prev.start + Math.max(prev.dur, 0);
    const gap = cur.start - prevEnd;
    const combined = joinText(prev.text, cur.text);
    const span = cur.start + Math.max(cur.dur, 0) - prev.start;

    if (gap >= 0 && gap <= maxGapMs && combined.length <= maxChars && span <= maxSpanMs) {
      prev.text = combined;
      // dur 未知时按 1.5s 估算，保证 SRT 的结束时间至少覆盖末段
      const tail = cur.start + (cur.dur > 0 ? cur.dur : 1_500) - prev.start;
      prev.dur = Math.max(prev.dur, tail);
      continue;
    }
    out.push(cur);
  }
  return out;
}
