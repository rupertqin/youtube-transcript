import { deepQueryWithin } from './shadow';
import { getSelectors } from './selectors';
import { countTimecodes } from './text-rows';

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const normalize = (value: string | null | undefined): string =>
  (value || '').replace(/\s+/g, ' ').trim();

export function isVisible(el: Element | null | undefined): boolean {
  if (!el) return false;
  if (el.getClientRects().length === 0) return false;
  const style = getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

export function waitForElement(
  doc: Document,
  selector: string,
  timeoutMs = 10000,
  intervalMs = 100,
): Promise<Element> {
  return new Promise((resolve, reject) => {
    let elapsed = 0;
    const timer = setInterval(() => {
      const el = doc.querySelector(selector);
      if (el) {
        clearInterval(timer);
        resolve(el);
        return;
      }
      elapsed += intervalMs;
      if (elapsed >= timeoutMs) {
        clearInterval(timer);
        reject(new Error(`element ${selector} not found within ${timeoutMs}ms`));
      }
    }, intervalMs);
  });
}

/**
 * 关闭时间线时 YouTube 只做 CSS 隐藏，DOM 文本仍在 —— 必须用可见性判断。
 * 除了标签名，也把「文本里已经出现 ≥2 个时间码行」当作就绪信号：
 * 2026 版面板换成了 *-view-model 元素，按老标签等会白等满超时。
 */
export async function waitForSegments(panel: ParentNode, timeoutMs = 8000): Promise<boolean> {
  const selectors = getSelectors();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(panel instanceof Element)) return false;
    if (
      deepQueryWithin(panel, selectors.list).length > 0 ||
      deepQueryWithin(panel, selectors.segOld).length > 0 ||
      deepQueryWithin(panel, selectors.segNew).length > 0
    ) {
      return true;
    }
    const text = 'innerText' in panel ? ((panel as HTMLElement).innerText ?? '') : '';
    if (countTimecodes(text) >= 2) return true;
    await sleep(150);
  }
  return false;
}
