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
 * 把 2–4 秒的 ASR 碎片拼成可读的行。
 *
 * 数据里只有**开始时间**：`endMs` / `dDurationMs` 常缺失或盖过下一段（算不出停顿），
 * 碎片大多数也不带句末标点（没法按句子切）。剩下的稳定信号只有一个 —— **时间跨度**。
 *
 * 这也正是 YouTube 原生面板的做法。同一份数据里原生面板的每一条：
 * 0:00→0:08（两段）、0:08→0:15（四段）、0:20→0:28（两段），
 * 字符数从 20 到 149 完全不固定，**跨度却稳定在 7–8 秒**，只在行首留一个时间码。
 * 所以这里用同一个粒度：**一行攒满约 8 秒就换行**。
 *
 * 跨度只用 `start`（本段起点 − 行首起点），不依赖结束时间 ——
 * 这是「停顿」之外唯一能算的东西，而且和原生面板的分组一致。
 *
 * 其它规则：
 * - `[CHEERING, APPLAUSE]` 这类音效/舞台提示独立成行，前后都断开
 * - 章节之间隔几分钟，跨度判据会自然把行断开，不用额外处理
 * - 中文边界不加空格，英文边界补一个空格
 * - 时间码异常（多段挤在同一秒）时用字数上限兜底，不至于滚成一整块
 * - 保留首段 `start`（点击跳转 / 播放高亮靠它）；`dur` 取到末段结束，
 *   异常超长的单段时长截到 4s，避免 SRT 结束时间串到下一段
 * O(n) 单次遍历。
 */
/** 一行覆盖的时间跨度上限（与原生面板 7–8 秒的粒度一致） */
const MERGE_MAX_SPAN_MS = 8_000;
/** 兜底：时间码异常（多段同一秒）时不至于无限变长 */
const MERGE_MAX_CHARS = 240;

const SOUND_CUE_RE = /^\[[^\]]{1,40}\]$/u;
const CJK_RE = /[\u3400-\u9fff\u3040-\u30ff\uf900-\ufaff]/u;

export interface MergeOptions {
  maxSpanMs?: number;
  maxChars?: number;
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
  const maxSpanMs = options.maxSpanMs ?? MERGE_MAX_SPAN_MS;
  const maxChars = options.maxChars ?? MERGE_MAX_CHARS;

  const out: TranscriptLine[] = [];
  /** 当前候选行的原始片段：片段不再切开，切了就没有对应的时间点 */
  let buf: TranscriptLine[] = [];
  let bufText = '';

  const emit = (items: readonly TranscriptLine[], text: string): void => {
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const dur =
      items.length === 1
        ? first.dur
        : Math.max(first.dur, last.start + Math.min(Math.max(last.dur, 1_500), 4_000) - first.start);
    out.push({ start: first.start, dur, text: text.trim() });
  };

  const flush = (): void => {
    emit(buf, bufText);
    buf = [];
    bufText = '';
  };

  for (const line of lines) {
    const cur: TranscriptLine = { ...line };
    const trimmed = cur.text.trim();
    if (!trimmed) continue;

    // 音效/舞台提示：独立成行，前后都断开
    if (SOUND_CUE_RE.test(trimmed)) {
      flush();
      out.push({ start: cur.start, dur: cur.dur, text: trimmed });
      continue;
    }

    // 没有时间码的行无法定位，单独成行
    if (cur.start < 0) {
      flush();
      out.push(cur);
      continue;
    }

    // 跨度从行首算起：攒满约 8 秒就换行（与原生面板一致）。
    // 字数上限只是兜底，防时间码异常（多段挤在同一秒）时滚成一整块。
    const span = buf.length === 0 ? 0 : cur.start - buf[0].start;
    const fitsChars = bufText.length + 1 + trimmed.length <= maxChars;
    if (buf.length > 0 && span < maxSpanMs && fitsChars) {
      buf.push(cur);
      bufText = joinText(bufText, trimmed);
      continue;
    }

    flush();
    buf = [cur];
    bufText = trimmed;
  }
  flush();
  return out;
}
