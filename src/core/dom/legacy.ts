import type { TranscriptLine } from '../types';
import type { LegacyV19 } from '../../legacy/contract';
import { dumpStructureSummary } from './dump';
import { deepElements, deepQueryAll } from './shadow';
import { parseTimecode } from './text-rows';
import { sleep } from './wait';

/**
 * 「逐步转移」第 2 步：只调用 verbatim-runtime.js 里原版 v1.9 自己的提取函数。
 *
 * 关键顺序修正（用户指出的「卡住的地方不对」）：
 * 原版 onclick 先 openTranscriptPanel() 再读文字；2026 版面板 target-id 变成
 * PAmodern_transcript_view，pickPanel() 认不出，于是去点 Show transcript ——
 * 而面板本来就开着（页面上有 Close transcript 按钮），这一下把它关掉了，
 * 字幕行随之消失，最后弹 Could not find the transcript panel。
 *
 * 现在按钮的职责回到「复制已有文字」：**先同步快照当前 DOM，命中就立刻返回，
 * 绝不点击任何按钮、不发任何请求**；只有确实读不到时才尝试打开面板。
 */

let lastDiagnostic = '';
let snapshotDiagnostic = '';

export function getLegacyDiagnostic(): string {
  return lastDiagnostic;
}

const LEADING_TIME = /^(\d{1,2}:\d{2}(?::\d{2})?)\s*(.*)$/u;
const TIMECODE_ROW = /^\d{1,2}:\d{2}(?::\d{2})?\s/u;
const TIMECODE_ANY = /\d{1,2}:\d{2}(?::\d{2})?/u;

function v19(): LegacyV19 | null {
  return globalThis.__yttLegacyV19 ?? null;
}

export interface LegacyExtractResult {
  lines: TranscriptLine[];
  showTimestamps: boolean;
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

function longestIncreasingRun(rows: string[]): string[] {
  let best: string[] = [];
  let current: string[] = [];
  let lastMs = -1;

  for (const row of rows) {
    const match = LEADING_TIME.exec(row);
    const ms = match ? parseTimecode(match[1]) : null;
    const usable = ms !== null && cleanRow(row);
    const continuous = usable && current.length > 0 && ms! > lastMs && ms! - lastMs <= MAX_SUBTITLE_GAP_MS;
    if (continuous) {
      current.push(row);
    } else {
      if (current.length > best.length) best = current;
      current = usable ? [row] : [];
    }
    lastMs = usable ? ms! : -1;
  }
  return current.length > best.length ? current : best;
}

/**
 * 构造一个 querySelector 恒为 null 的伪 panel，让原版 extractFallback
 * 的 `scope = panel`，从而把我们给的文本按它自己的时间码规则切开。
 * 提取逻辑一字不改，只换「喂给它什么文本」。
 */
function pseudoPanel(raw: string): Element {
  return { querySelector: () => null, innerText: raw } as unknown as Element;
}

/**
 * 同步读取当前页面上的字幕文字，不点击、不等待、不发请求。
 *
 * 文本源只用可见文本：body.innerText（原版注释明确用它排除隐藏节点），
 * 以及穿透 shadow root 后含时间码的候选元素。**不再用 body.textContent** ——
 * 它会把页面内嵌的 ytInitialData JSON（章节列表）也带进来，切出
 * `28:14 ] — Rethinking…\n[` 这种假字幕。
 * 每个源都交给**同一个原版 extractFallback()**，取时间戳最长递增段。
 */
export function snapshotTranscriptText(doc: Document, options: { quick?: boolean } = {}): string {
  const legacy = v19();
  if (!legacy) {
    snapshotDiagnostic = '快照: 原版运行时未加载';
    return '';
  }

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
          if (raw.length > 20 && raw.length < 100000 && TIMECODE_ANY.test(raw)) {
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

  let best = { text: '', rows: 0, label: '' };
  const hits: string[] = [];
  for (const { label, raw } of sources) {
    if (!raw) continue;
    let cut = '';
    try {
      cut = legacy.extractFallback(pseudoPanel(raw)).text;
    } catch {
      continue;
    }
    const rows = cut ? cut.split('\n').filter(Boolean) : [];
    const timed = rows.filter((row) => TIMECODE_ROW.test(row) && cleanRow(row));
    const segment = longestIncreasingRun(timed);
    if (segment.length > best.rows) {
      best = { text: segment.join('\n'), rows: segment.length, label };
    }
    if (segment.length >= 3) hits.push(`${label}:${segment.length}`);
  }

  snapshotDiagnostic =
    `快照: ${sources.length} 个可见文本源；最长递增段 ${best.rows} 行（${best.label || '无'}）` +
    `；章节间隔>45s 已排除` +
    (hits.length > 0 ? `；命中源 ${hits.slice(0, 4).join(' / ')}` : '') +
    (best.rows > 0 ? `；预览 ${best.text.split('\n')[0]?.slice(0, 40) ?? ''}` : '');
  return best.rows >= 3 ? best.text : '';
}

/** 面板已经 EXPANDED 时，绝不能再让原版 openTranscriptPanel 去点 Show transcript。 */
function transcriptPanelExpanded(doc: Document): boolean {
  try {
    const expanded = deepQueryAll(doc, '[visibility]').some((el) =>
      (el.getAttribute('visibility') || '').includes('EXPANDED'),
    );
    if (expanded) return true;
    return deepQueryAll(doc, 'button, [role="button"]').some((el) => {
      const label = `${el.getAttribute('aria-label') ?? ''} ${el.textContent ?? ''}`;
      return (
        /close\s*transcript/iu.test(label) &&
        typeof el.getClientRects === 'function' &&
        el.getClientRects().length > 0
      );
    });
  } catch {
    return false;
  }
}

const TAB_SELECTOR = [
  'button',
  '[role="tab"]',
  'yt-chip-cloud-chip-renderer',
  'yt-tab-shape',
].join(',');

/**
 * 面板已经 EXPANDED 但停在 Chapters 标签页时，精确点「Transcript」标签，
 * 让 YouTube 自己渲染字幕行（并发它自己的 get_transcript 请求）。
 *
 * 只认文案**恰好**等于 Transcript 的元素，因此不会误点：
 *   Show transcript（描述区的入口）、Copy Transcript（原版按钮）、
 *   Transcript v2.x（我们自己的按钮）。
 * 这一步属于新版 dom 层；逐字节的 verbatim-runtime.js 与它注入的按钮不受影响。
 */
async function switchToTranscriptTab(doc: Document): Promise<string> {
  let candidates: Element[] = [];
  try {
    candidates = deepQueryAll(doc, TAB_SELECTOR);
  } catch {
    return 'Transcript 标签查询失败';
  }

  const tabs = candidates.filter((el) => {
    if (el.id === 'ytt-entry-btn' || el.id === 'copy-transcript-btn') return false;
    const label = (el.textContent || '').replace(/\s+/gu, ' ').trim();
    const aria = (el.getAttribute('aria-label') || '').trim();
    return /^transcript$/iu.test(label) || /^transcript$/iu.test(aria);
  });
  if (tabs.length === 0) return `未找到 Transcript 标签（可点候选 ${candidates.length} 个）`;

  const tab = tabs[0] as HTMLElement;
  if (typeof tab.click !== 'function') return 'Transcript 标签不可点击';
  tab.click();
  await sleep(300);
  return `已点击 Transcript 标签 <${tab.tagName.toLowerCase()} class="${(tab.getAttribute('class') || '').slice(0, 40)}">（匹配 ${tabs.length} 个）`;
}

export async function extractTranscriptLegacy(doc: Document): Promise<LegacyExtractResult> {
  const legacy = v19();
  const notes: string[] = [];

  // ⓪ 先读已有文字：命中就返回，一个按钮都不点
  let text = snapshotTranscriptText(doc);
  notes.push(snapshotDiagnostic);
  if (text) notes.push('采用当前 DOM 快照（未点击任何按钮、未发请求）');

  if (!text && legacy) {
    // ① 面板已 EXPANDED 但停在 Chapters：点 Transcript 标签让 YouTube 渲染字幕行。
    //    不再点 Show transcript —— 那会把已经展开的面板关掉。
    notes.push(await switchToTranscriptTab(doc));

    // ② 等渲染。面板是虚拟列表，行可能分批出现，所以轮询快照
    for (let i = 0; i < 12 && !text; i += 1) {
      await sleep(250);
      const after = snapshotTranscriptText(doc);
      if (after) {
        text = after;
        notes.push(`切标签后第 ${i + 1} 次轮询读出 ${after.split('\n').length} 行`);
      }
    }
    if (!text) notes.push(`切标签后快照实况: ${snapshotDiagnostic}`);

    // ③ 仍读不到 → 走逐字节原版的完整流程。
    //    user-script.js 修好后，openTranscriptPanel() 自己能认出 2026 面板、
    //    字幕行一出现就返回，不再需要「面板已展开就跳过」这层保护；
    //    pickPanel() 只在能切出连续字幕行时才认面板，所以早退分支也不会误点。
    if (!text) {
      notes.push(
        `切标签后仍无字幕 → 走原版 openTranscriptPanel（${
          transcriptPanelExpanded(doc) ? '面板已展开' : '面板未展开'
        }）`,
      );
      const panel = await legacy.openTranscriptPanel();
      if (panel) {
        notes.push(
          `原版面板识别成功 <${panel.tagName.toLowerCase()} target-id="${panel.getAttribute('target-id') ?? ''}">`,
        );
        const result = await legacy.extractTranscript(panel);
        if (result.text) {
          text = result.text;
          notes.push(`原版 extractTranscript → ${result.text.length} 字符`);
        }
      } else {
        notes.push('原版 openTranscriptPanel 未找到面板（原版此时会弹 Could not find…）');
      }
      const after = snapshotTranscriptText(doc);
      notes.push(`原版流程后快照: ${after ? `${after.split('\n').length} 行` : '仍为空'}`);
      if (after && after.length > text.length) {
        text = after;
        notes.push('改用原版流程后的快照');
      }
    }
  }

  const lines = toLines(text);
  const parts = [`原版运行时: ${lines.length} 行 / ${text.length} 字符`, ...notes];
  if (lines.length === 0) {
    try {
      parts.push('--- 页面结构摘要 ---', dumpStructureSummary(doc));
    } catch (error) {
      parts.push(`页面结构摘要失败: ${String(error)}`);
    }
  }
  lastDiagnostic = parts.join('；');

  return { lines, showTimestamps: lines.length > 0 };
}
