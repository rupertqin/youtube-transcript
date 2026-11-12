import { getSelectors } from './selectors';
import { countTimecodes } from './text-rows';
import { isVisible, sleep, waitForSegments } from './wait';

export function countSegments(root: ParentNode): number {
  const selectors = getSelectors();
  if (!root.querySelector(selectors.list) && !root.querySelector(selectors.segOld)) return -1;
  return root.querySelectorAll(`${selectors.segOld},${selectors.segNew}`).length;
}

/**
 * 多个候选面板时取「内容最像字幕」的那个。
 * 先看文本里的时间码行数（与标签名无关），再看片段元素数量 —— 新版面板
 * 可能一个老标签都匹配不到，但文本一定是对的。
 */
export function scorePanel(el: Element): number {
  const node = el as HTMLElement;
  const text = node.innerText || node.textContent || '';
  return countTimecodes(text) * 10 + Math.max(0, countSegments(el));
}

export function pickPanel(doc: Document): Element | null {
  const selectors = getSelectors();
  const all = Array.from(doc.querySelectorAll(selectors.panels));
  const visible = all.filter(isVisible);
  const pool = visible.length ? visible : all;
  if (pool.length === 0) return null;
  pool.sort((a, b) => scorePanel(b) - scorePanel(a));
  return pool[0];
}

function findTrigger(doc: Document): HTMLElement | null {
  const buttons = Array.from(doc.querySelectorAll<HTMLElement>('button, yt-button-shape button'));
  return (
    buttons.find((b) => /show\s*transcript/iu.test(b.textContent || '')) ||
    buttons.find((b) => /transcript/iu.test(b.textContent || '')) ||
    null
  );
}

/**
 * 面板已存在时只等待加载，绝不二次点击 —— 二次点击会挂出重复列表。
 */
export async function openTranscriptPanel(
  doc: Document,
  options: { waitMs?: number; timeoutMs?: number } = {},
): Promise<Element | null> {
  const { waitMs = 3000, timeoutMs = 8000 } = options;

  let panel = pickPanel(doc);
  if (panel) {
    await waitForSegments(panel, waitMs);
    return panel;
  }

  const trigger = findTrigger(doc);
  if (trigger) {
    trigger.click();
    await sleep(400);
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    panel = pickPanel(doc);
    if (panel && scorePanel(panel) > 0) return panel;
    await sleep(150);
  }
  return panel ?? null;
}

/**
 * 关闭原生面板（抓完 DOM 后还页面一个干净视图）。
 * 面板只是抓取用的临时载体，无论成功失败都要收掉，否则页面上会同时存在两套字幕 UI。
 */
export function closeTranscriptPanel(doc: Document, panel: Element | null): void {
  const scope = panel ?? doc;
  const closer =
    scope.querySelector<HTMLElement>('#visibility-button button') ??
    scope.querySelector<HTMLElement>('ytd-engagement-panel-title-header-renderer #visibility-button button') ??
    doc.querySelector<HTMLElement>(
      'ytd-engagement-panel-section-list-renderer[target-id*="transcript"] #visibility-button button',
    );
  closer?.click();
}
