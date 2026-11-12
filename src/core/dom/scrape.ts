import type { TranscriptLine } from '../types';
import { looksLikeTranscript } from '../lines';
import { collapseDuplicates } from './dedupe';
import { getTriggerInfo } from './panel';
import { deepElements, deepQueryAll, deepQueryWithin } from './shadow';
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
  if (!(root instanceof Element)) return { lines: [], showTimestamps: false };
  const scope =
    (deepQueryWithin(root, selectors.list)[0] as HTMLElement | undefined) ?? (root as HTMLElement);
  // 面板折叠时 innerText 为空，但 DOM 文本还在 —— 退回 textContent（范围仍限于面板内部）
  const raw = scope.innerText || scope.textContent || '';

  const rows = parseTimecodeRows(raw);
  if (rows.length > 0) return { lines: rows, showTimestamps: true };

  // 与 1.x 一致：没有时间码就当没读到内容。
  // 以前这里会「按行收」，结果把面板标题（Transcript）当成唯一一行字幕显示出来。
  return { lines: [], showTimestamps: false };
}

/** 标签命中 → 纯文本兜底，逐个根节点尝试。 */
function scrapeRoot(root: ParentNode): ScrapeResult | null {
  const selectors = getSelectors();
  if (!(root instanceof Element)) return null;
  const lists = deepQueryWithin(root, selectors.list).filter(isVisible);
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

export { looksLikeTranscript };

const LEADING_TIME_RE = /^(\d{1,2}:\d{2}(?::\d{2})?)\s*(.+)$/u;

/**
 * 结构签名探测：一个有 ≥8 个子元素、且多数子元素以「时间码」开头的容器就是字幕列表。
 *
 * 与标签名完全无关 —— 2026 版面板换成 view-model 元素后，`ytd-transcript-segment-*`
 * 可能一个都不存在，但「一行 = 时间码 + 正文」这个形状不会变。
 * 不会误伤推荐列表：那里的子元素以标题开头，时长是缩略图上的角标。
 */
export function findTranscriptLists(doc: Document): Element[] {
  const found: Element[] = [];
  // deepElements 覆盖 light DOM + 所有可达 shadow root
  for (const { elements } of deepElements(doc)) {
    for (const el of elements) {
      const kids = el.children;
      if (kids.length < 8) continue;

      const probe = Math.min(kids.length, 12);
      let hits = 0;
      for (let i = 0; i < probe; i += 1) {
        const text = (kids[i].textContent || '').replace(/\s+/gu, ' ').trim();
        if (/^\d{1,2}:\d{2}(?::\d{2})?(\s|$)/u.test(text)) hits += 1;
      }
      if (hits / probe >= 0.7) found.push(el);
    }
  }
  return found;
}

/** 按结构签名逐行读：每行取行首时间码 + 其余正文。 */
export function collectFromShape(list: Element): ScrapeResult {
  const lines: TranscriptLine[] = [];
  for (const row of Array.from(list.children)) {
    const text = (row.textContent || '').replace(/\s+/gu, ' ').trim();
    const match = LEADING_TIME_RE.exec(text);
    if (!match) continue;
    const start = parseTimecode(match[1]);
    const body = normalize(match[2]);
    if (start === null || !body) continue;
    lines.push({ start, dur: 0, text: body });
  }
  return { lines, showTimestamps: true };
}

/** 同一个播放页可能有多个字幕面板实例（portal、动画中的旧节点），都拿来做候选。 */
function otherTranscriptPanels(panel: Element): Element[] {
  const doc = panel.ownerDocument;
  if (!doc) return [];
  return Array.from(doc.querySelectorAll(getSelectors().panels)).filter((el) => el !== panel);
}

/** 逐个候选面板尝试：标签名（老结构最准）→ 面板文本（新结构兜底）。 */
function tryCandidates(panel: Element): ScrapeResult | null {
  const doc = panel.ownerDocument;
  // 面板壳可能匹配不到，但真正的列表在页面上（含 shadow root）
  const globalLists = doc ? deepQueryAll(doc, getSelectors().list).filter(isVisible) : [];
  const candidates = [...globalLists, panel, ...otherTranscriptPanels(panel)].filter(
    (el) => el.isConnected,
  );

  for (const candidate of candidates) {
    // 标签命中即用（1.x 语义），但仍要过「像不像字幕」这道闸：
    // 面板标题、tab 文案这类单行内容不算结果
    const byTag = scrapeRoot(candidate);
    if (byTag && looksLikeTranscript(byTag.lines)) return byTag;

    // 文本兜底才需要校验：这里读到的是整块文本，可能混进面板标题之类的东西
    const byText = extractFallback(candidate);
    if (byText.lines.length > 0 && looksLikeTranscript(byText.lines)) return byText;
  }

  return null;
}

let lastDiagnostic = '';

/** 最近一次 DOM 抓取失败时的面板结构快照（面板里会直接显示出来）。 */
export function getDomDiagnostic(): string {
  return lastDiagnostic;
}

/** 失败时把面板结构打进控制台，方便一次性拿到真实 DOM（不用再猜选择器）。 */
function describePanel(panel: Element): string {
  const node = panel as HTMLElement;
  const kids = Array.from(panel.children)
    .slice(0, 12)
    .map((el) => el.tagName.toLowerCase() + (el.id ? `#${el.id}` : ''))
    .join(', ');
  const text = (node.innerText || node.textContent || '').replace(/\s+/gu, ' ').slice(0, 160);
  const clickable = Array.from(
    panel.querySelectorAll<HTMLElement>('button, [role="tab"], yt-chip-cloud-chip-renderer, a'),
  )
    .map((el) => (el.textContent || '').replace(/\s+/gu, ' ').trim())
    .filter((label) => label.length > 0 && label.length <= 24)
    .slice(0, 6)
    .join(' / ');
  const doc = panel.ownerDocument;
  const shapes = doc ? findTranscriptLists(doc).length : 0;
  return [
    `触发器: ${getTriggerInfo()}`,
    `面板: <${panel.tagName.toLowerCase()}${panel.id ? ` id="${panel.id}"` : ''}>`,
    `子元素: ${kids || '(无)'}`,
    `可点标签: ${clickable || '(无)'}`,
    `文本前 160 字: ${text || '(空)'}`,
    `结构探测: ${shapes} 个字幕列表候选`,
  ].join('\n');
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
  let lastShapeScan = 0;

  for (;;) {
    let result = tryCandidates(panel);

    // 标签完全对不上时，改用「行形状」在整页找一次（结构性判断，不是把页面文本当字幕）
    const doc = panel.ownerDocument;
    if (!result && doc && Date.now() - lastShapeScan > 700) {
      lastShapeScan = Date.now();
      const lists = findTranscriptLists(doc)
        .map((list) => collectFromShape(list))
        .filter((shape) => looksLikeTranscript(shape.lines))
        .sort((a, b) => b.lines.length - a.lines.length);
      if (lists.length > 0) result = lists[0];
    }

    if (result) lastDiagnostic = '';
    if (result && result.lines.length > (best?.lines.length ?? 0)) best = result;
    if (best && best.lines.length >= 8) return best;

    if (Date.now() >= deadline) {
      if (!best) {
        lastDiagnostic = describePanel(panel);
        console.warn('[ytt] DOM 抓取失败，面板结构如下（把这段发出来即可定位选择器）:');
        console.warn(lastDiagnostic);
      }
      return best ?? { lines: [], showTimestamps: false };
    }
    await sleep(250);
  }
}
