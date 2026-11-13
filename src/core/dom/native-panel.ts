import type { TranscriptLine } from '../types';
import { readPlayerVideoId } from '../harvest/player';
import { deepElements } from './shadow';
import { parseTimecode, parseTimecodeRows } from './text-rows';
import { formatTimestamp } from '../format/export';
import { contentSignature } from '../format/fingerprint';

/**
 * DOM 预览层：同步读页面上**已经渲染**的字幕文字。
 *
 * 这里**不点击、不等待、不滚动**：一次可见文本扫描就返回。
 * 虚拟列表只渲染视口内的行，所以这份结果天生不完整，只能临时显示
 * （`complete: false`），绝不写缓存、绝不短路结构化完整源。
 * 靠滚面板凑全字幕既慢又会漏行，那条路已经彻底删掉。
 *
 * 切页之后，与上一条视频内容完全一致的快照一律丢弃（`avoidSignature`）。
 */

let lastDiagnostic = '';
let snapshotDiagnostic = '';

export function getDomDiagnostic(): string {
  return lastDiagnostic;
}

const LEADING_TIME = /^(\d{1,2}:\d{2}(?::\d{2})?)\s*(.*)$/u;
const TIMECODE_ROW = /^\d{1,2}:\d{2}(?::\d{2})?\s/u;

export interface NativePanelResult {
  lines: TranscriptLine[];
  showTimestamps: boolean;
}

export interface NativePanelOptions {
  /**
   * 目标视频 id。
   *
   * SPA 切页时地址栏先变、播放器后变，这段时间 DOM 里挂着的还是上一个视频
   * 的字幕行。带上这个参数就能在开抓前把它认出来并放弃，否则面板会一直
   * 显示上一个视频的内容。
   */
  videoId?: string;
  /**
   * 刚切换过视频：不要用「页面现有文字」直接返回。
   *
   * 原生面板里的行不携带 videoId，切页后 YouTube 还会留着上一页的行，
   * 光靠播放器 id 校验不出来。这种时候必须让面板按新视频重新渲染一次，
   * 宁可多花几百毫秒。
   */
  skipSnapshot?: boolean;
  /**
   * 切换前那条视频的内容指纹。
   *
   * 这是切页后**唯一有效**的判据：旧面板里的行不带 videoId，而播放器已经切到
   * 新视频，`staleVideoNote()` 必然放行。凡是与它完全一致的内容，一律当成
   * 「原生面板还没重建」丢弃，继续等或换下一层。
   */
  avoidSignature?: string | null;
}

/**
 * DOM 里的内容是否还属于**另一个**视频。
 * 返回 null 表示无法判断（没有 window、播放器还没就绪），此时不拦截 ——
 * 宁可多试一次，也不能在首屏把正常抓取误杀。
 */
function staleVideoNote(doc: Document, expected?: string): string | null {
  if (!expected) return null;
  const win = (doc.defaultView ?? (typeof window === 'undefined' ? null : window)) as Window | null;
  if (!win) return null;

  let actual: string | null = null;
  try {
    actual = readPlayerVideoId(win);
  } catch {
    return null;
  }
  if (!actual || actual === expected) return null;
  return `videoId mismatch: expected=${expected} actual=${actual}`;
}

function toLines(text: string): TranscriptLine[] {
  return text
    .split('\n')
    .map((line) => line.replace(/\s+/gu, ' ').trim())
    .filter(Boolean)
    .map((line) => {
      const match = LEADING_TIME.exec(line);
      const start = match ? parseTimecode(match[1]) : null;
      return { start: start ?? -1, dur: 0, text: start === null ? line : (match?.[2] ?? '') };
    })
    .filter((line) => line.text.length > 0);
}

/**
 * 字幕相邻行只隔几秒到几十秒；章节时间点（28:14 → 33:04 → 34:23…）隔几分钟。
 * 用 45 秒上限把章节列表切开，再用「至少 3 行连续」挡掉零散时长。
 */
const MAX_SUBTITLE_GAP_MS = 45 * 1000;

/** 整页 textContent 会把 ytInitialData 的 JSON 带进来（截图里的 `] — …\n[`）。 */
function cleanRow(row: string): boolean {
  if (row.length > 300) return false;
  if (/\\n|\[|\]|\{["\w]/u.test(row)) return false;
  return true;
}

type Row = { start: number; text: string };

function longestIncreasingRun(rows: Row[]): Row[] {
  let best: Row[] = [];
  let current: Row[] = [];
  let lastMs = -1;

  for (const row of rows) {
    const usable = row.start >= 0 && cleanRow(row.text);
    const continuous =
      usable && current.length > 0 && row.start > lastMs && row.start - lastMs <= MAX_SUBTITLE_GAP_MS;
    if (continuous) {
      current.push(row);
    } else {
      if (current.length > best.length) best = current;
      current = usable ? [row] : [];
    }
    lastMs = usable ? row.start : -1;
  }
  return current.length > best.length ? current : best;
}

/** 一段原始文本里，有没有像字幕那样「连续递增」的时间码行。 */
function pickRows(raw: string): Row[] {
  const rows = parseTimecodeRows(raw)
    .filter((row) => row.start >= 0 && row.text.length > 0)
    .map((row) => ({ start: row.start, text: row.text }));
  return longestIncreasingRun(rows);
}

/**
 * 同步读取当前页面上的字幕文字，不点击、不等待、不发请求。
 *
 * 文本源只用可见文本：body.innerText（排除隐藏节点），以及穿透 shadow root
 * 后含时间码的候选元素。**不用 body.textContent** —— 它会把页面内嵌的
 * ytInitialData JSON（章节列表）也带进来，切出 `28:14 ] — Rethinking…` 这种假字幕。
 * 每个源都按时间码切行，取时间戳最长递增段。
 */
export function snapshotTranscriptText(doc: Document, options: { quick?: boolean } = {}): string {
  const sources: { label: string; raw: string }[] = [];
  const body = doc.body as HTMLElement | null;
  if (body) {
    sources.push({ label: 'body.innerText', raw: body.innerText || '' });
  }
  // quick：只扫可见文本，不遍历整页候选元素
  if (!options.quick) {
    try {
      const candidates: { label: string; raw: string }[] = [];
      for (const { elements } of deepElements(doc)) {
        for (const el of elements) {
          const raw = el.textContent || '';
          if (raw.length > 20 && raw.length < 100000 && TIMECODE_ROW.test(raw)) {
            candidates.push({ label: `<${el.tagName.toLowerCase()}>`, raw });
          }
        }
      }
      // 短文本更像字幕列表，长文本多半是整个页面
      candidates.sort((a, b) => a.raw.length - b.raw.length);
      sources.push(...candidates.slice(0, 24));
    } catch {
      /* 穿透查询失败不影响前两个源 */
    }
  }

  let best = { rows: [] as Row[], label: '' };
  const hits: string[] = [];
  for (const { label, raw } of sources) {
    if (!raw) continue;
    let rows: Row[] = [];
    try {
      rows = pickRows(raw);
    } catch {
      continue;
    }
    if (rows.length > best.rows.length) best = { rows, label };
    if (rows.length >= 3) hits.push(`${label}:${rows.length}`);
  }

  const first = best.rows[0];
  snapshotDiagnostic =
    `快照: ${sources.length} 个可见文本源；最长递增段 ${best.rows.length} 行（${best.label || '无'}）` +
    `；章节间隔>45s 已排除` +
    (hits.length > 0 ? `；命中源 ${hits.slice(0, 4).join(' / ')}` : '') +
    (first ? `；预览 ${first.text.slice(0, 40)}` : '');

  if (best.rows.length < 3) return '';
  return best.rows.map((row) => `${formatTimestamp(row.start)} ${row.text}`).join('\n');
}

/**
 * 读一次页面上已渲染的字幕，作为**临时预览**。
 *
 * 归属校验两道：
 * - `videoId`：播放器还停在别的视频时，页面文字必然不属于当前视频；
 * - `avoidSignature`：旧面板里的行不带 videoId，播放器却已经切到新视频，
 *   这时只有「内容和上一条完全一样」能认出它是残留。
 */
export function readDomPreview(doc: Document, options: NativePanelOptions = {}): NativePanelResult {
  const notes: string[] = [];

  const beforeStart = staleVideoNote(doc, options.videoId);
  if (beforeStart) {
    notes.push(`${beforeStart} → 放弃 DOM 预览`);
    lastDiagnostic = notes.join('；');
    return { lines: [], showTimestamps: false };
  }

  if (options.skipSnapshot) {
    notes.push('刚切页：跳过页面现有文字，等待完整字幕');
    lastDiagnostic = notes.join('；');
    return { lines: [], showTimestamps: false };
  }

  const text = snapshotTranscriptText(doc, { quick: true });
  notes.push(snapshotDiagnostic);
  let rows = text ? toLines(text) : [];
  if (rows.length > 0) notes.push('同步读取已渲染的字幕（预览，未点击任何按钮）');

  const avoid = options.avoidSignature ?? null;
  if (avoid && rows.length > 0 && contentSignature(rows) === avoid) {
    notes.unshift('丢弃与上一条视频相同的内容 1 次（原生面板尚未按新视频重建）');
    rows = [];
  }

  lastDiagnostic = [`DOM 预览: ${rows.length} 行`, ...notes].join('；');
  return { lines: rows, showTimestamps: rows.some((row) => row.start >= 0) };
}

/** 兼容旧调用点：DOM 预览是同步的，保持 async 签名避免逐个改宿主。 */
export async function extractFromNativePanel(
  doc: Document,
  options: NativePanelOptions = {},
): Promise<NativePanelResult> {
  return readDomPreview(doc, options);
}
