import type { TranscriptLine } from './types';

export function hasTimestamps(lines: TranscriptLine[]): boolean {
  return lines.some((line) => line.start >= 0);
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
