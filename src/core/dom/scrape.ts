import type { TranscriptLine } from '../types';
import { collapseDuplicates } from './dedupe';
import { getSelectors } from './selectors';
import { parseTimecode, parseTimecodeRows } from './text-rows';
import { isVisible, normalize, sleep } from './wait';

export { parseTimecode };

/** 新旧两套元素互斥使用，避免同一片段被两套选择器同时命中。 */
export function segmentSelectorFor(list: ParentNode): string {
  const selectors = getSelectors();
  return list.querySelector(selectors.segNew) ? selectors.segNew : selectors.segOld;
}

export interface ScrapeResult {
  lines: TranscriptLine[];
  showTimestamps: boolean;
}

export function collectFromList(list: ParentNode): ScrapeResult & { segCount: number } {
  const selectors = getSelectors();
  const segSel = segmentSelectorFor(list);
  // 元素级去重：同一节点被多个选择器命中时只保留一次
  const segments = Array.from(new Set(Array.from(list.querySelectorAll(segSel))));
  if (segments.length === 0) return { lines: [], showTimestamps: false, segCount: 0 };

  // 以首段的时间戳单元格为探针判定开关状态；节点被整体移除时探针为 null → 视为隐藏
  const first = segments[0];
  const probe = first.querySelector(selectors.stamp);
  const showTimestamps = isVisible(probe);

  const lines: TranscriptLine[] = [];
  for (const seg of segments) {
    const stampEl = seg.querySelector(selectors.stamp);
    const textEl = seg.querySelector(selectors.text) || seg.querySelector('yt-formatted-string');
    const text = normalize(textEl ? (textEl as HTMLElement).innerText || textEl.textContent : '');
    if (!text) continue; // 行是否有效只看正文，不看时间戳

    let start = -1;
    if (showTimestamps && isVisible(stampEl)) {
      const parsed = parseTimecode(normalize(stampEl!.textContent));
      if (parsed !== null) start = parsed;
    }
    lines.push({ start, dur: 0, text });
  }

  return { lines, showTimestamps, segCount: segments.length };
}

/**
 * 纯文本兜底：与标签名完全无关。
 * 面板的 innerText 一定是「时间码 正文」的形状，标签怎么改都能读出来。
 */
export function extractFallback(root: ParentNode): ScrapeResult {
  const selectors = getSelectors();
  const scope = (root.querySelector(selectors.list) as HTMLElement | null) ?? (root as HTMLElement);
  // 面板折叠时 innerText 为空，但 DOM 文本还在 —— 退回 textContent（范围仍限于面板内部）
  const raw = scope.innerText || scope.textContent || '';

  const rows = parseTimecodeRows(raw);
  if (rows.length > 0) return { lines: rows, showTimestamps: true };

  // 连时间码都没有（用户关掉了时间戳）：按行收，至少别丢内容
  const plain = raw
    .split('\n')
    .map((line) => normalize(line))
    .filter((line) => line.length > 0);
  return plain.length > 0
    ? { lines: plain.map((text) => ({ start: -1, dur: 0, text })), showTimestamps: false }
    : { lines: [], showTimestamps: false };
}

/** 标签命中 → 纯文本兜底，逐个根节点尝试。 */
function scrapeRoot(root: ParentNode): ScrapeResult | null {
  const selectors = getSelectors();
  const lists = Array.from(root.querySelectorAll(selectors.list)).filter(isVisible);
  const candidates: ParentNode[] = lists.length ? lists : [root];

  for (const list of candidates) {
    const result = collectFromList(list);
    if (result.lines.length === 0) continue;

    // 触发激进去重的三个信号：多列表 / 片段数与行数不符 / 重复率超过 30%
    const distinct = new Set(result.lines.map((line) => line.text)).size;
    const aggressive =
      lists.length > 1 || result.segCount !== result.lines.length || distinct < result.lines.length * 0.7;

    return {
      lines: collapseDuplicates(result.lines, aggressive),
      showTimestamps: result.showTimestamps,
    };
  }

  return null;
}

/** 播放列表、推荐位、页脚这些装饰词一旦占多数，就说明读到的不是字幕。 */
const PAGE_CHROME_RE = /(订阅|subscriber|观看|views\b|\bago\b|comments?|comments?\b|watching|推荐|分享|share)/iu;

/**
 * 兜底文本有可能来自「面板外的页面区域」（推荐列表也带 30:24 这种时长徽标），
 * 命中页面装饰词过半就拒收 —— 宁可报 SELECTOR_MISS，也不能把推荐列表当字幕。
 */
export function looksLikeTranscript(lines: TranscriptLine[]): boolean {
  if (lines.length === 0) return false;
  const chrome = lines.filter((line) => PAGE_CHROME_RE.test(line.text)).length;
  return chrome / lines.length < 0.35;
}

/** 同一个播放页可能有多个字幕面板实例（portal、动画中的旧节点），都拿来做候选。 */
function otherTranscriptPanels(panel: Element): Element[] {
  const doc = panel.ownerDocument;
  if (!doc) return [];
  return Array.from(doc.querySelectorAll(getSelectors().panels)).filter((el) => el !== panel);
}

/** 逐个候选面板尝试：标签名（老结构最准）→ 面板文本（新结构兜底）。 */
function tryCandidates(panel: Element): ScrapeResult | null {
  const candidates = [panel, ...otherTranscriptPanels(panel)].filter((el) => el.isConnected);

  for (const candidate of candidates) {
    const byTag = scrapeRoot(candidate);
    if (byTag && looksLikeTranscript(byTag.lines)) return byTag;

    const byText = extractFallback(candidate);
    if (byText.lines.length > 0 && looksLikeTranscript(byText.lines)) return byText;
  }

  return null;
}

/**
 * 与 1.x 原版一致：**只在原生字幕面板内部读**，绝不扫整页。
 *
 * 用「边等边试」代替就绪判定：面板可能没有时间戳列（用户关掉了），
 * 单靠「有片段标签/有时间码」判断会白等到超时。行数够多就直接返回；
 * 不够多则继续累积，超时后返回看到的最全的一份。
 */
export async function scrapePanel(panel: Element, waitMs = 6000): Promise<ScrapeResult> {
  const deadline = Date.now() + waitMs;
  let best: ScrapeResult | null = null;

  for (;;) {
    const result = tryCandidates(panel);
    if (result && result.lines.length > (best?.lines.length ?? 0)) best = result;
    if (best && best.lines.length >= 8) return best;

    if (Date.now() >= deadline) return best ?? { lines: [], showTimestamps: false };
    await sleep(250);
  }
}
