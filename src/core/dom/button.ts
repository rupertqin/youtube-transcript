import { getSelectors } from './selectors';
import { waitForElement } from './wait';

export const ENTRY_BUTTON_ID = 'ytt-entry-btn';

export interface EntryButtonOptions {
  doc: Document;
  label?: string;
  title?: string;
  id?: string;
  /** 徽标文案；null 表示不显示，缺省显示版本号 */
  badge?: string | null;
  onClick: (event: MouseEvent) => void;
}

function buildIcon(doc: Document): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');

  // 与扩展图标同一个标记：字母 Y（YouTube 的首字母），三段等宽圆头线
  const mark = doc.createElementNS(ns, 'path');
  mark.setAttribute('d', 'M4.6 4.3 L10 9.7 M15.4 4.3 L10 9.7 M10 9.7 L10 15.7');
  mark.setAttribute('stroke', 'currentColor');
  mark.setAttribute('stroke-width', '3');
  mark.setAttribute('stroke-linecap', 'round');
  mark.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(mark);
  return svg;
}

/**
 * 造一个入口按钮，**不挂载**。
 *
 * 拆出来是因为两个挂载点需要同一副皮囊：YouTube 挂 masthead（`ensureEntryButton`），
 * B 站挂在右下浮层里（`ui/float.ts`）。样式全内联 —— 两个站点的全局 CSS 都很凶。
 */
export function createEntryButton(options: EntryButtonOptions): HTMLButtonElement {
  const { doc, label = 'Transcript', onClick, id = ENTRY_BUTTON_ID } = options;
  const version = typeof __YTT_VERSION__ === 'string' ? __YTT_VERSION__ : 'dev';
  const title = options.title ?? `打开字幕面板 · v${version}`;
  const badgeText = options.badge === undefined ? `v${version}` : options.badge;

  const button = doc.createElement('button');
  button.id = id;
  button.type = 'button';
  button.title = title;
  button.setAttribute('aria-label', title);
  button.style.cssText = [
    'display:inline-flex',
    'align-items:center',
    'gap:6px',
    'height:34px',
    'padding:0 12px',
    'border:1px solid rgba(255,255,255,0.14)',
    'border-radius:999px',
    'background:linear-gradient(135deg,#ff4e45,#ff7a45)',
    'color:#fff',
    'font-family:Roboto,Arial,sans-serif',
    'font-size:14px',
    'font-weight:500',
    'cursor:pointer',
    'box-shadow:0 2px 10px rgba(255,78,69,.28)',
    'transition:transform .16s ease,box-shadow .16s ease,filter .16s ease',
  ].join(';');

  button.appendChild(buildIcon(doc));
  const text = doc.createElement('span');
  text.dataset.role = 'label';
  text.textContent = label;
  button.appendChild(text);

  // 版本号直接印在按钮上：不用打开面板就能确认跑的是哪一版
  if (badgeText) {
    const badge = doc.createElement('span');
    badge.textContent = badgeText;
    badge.style.cssText =
      'font-size:10px;font-weight:600;line-height:1;padding:2px 5px;border-radius:999px;' +
      'background:rgba(0,0,0,.22);opacity:.9;letter-spacing:0';
    button.appendChild(badge);
  }

  button.addEventListener('mouseenter', () => {
    button.style.transform = 'translateY(-1px)';
    button.style.boxShadow = '0 6px 18px rgba(255,78,69,.4)';
    button.style.filter = 'brightness(1.05)';
  });
  button.addEventListener('mouseleave', () => {
    button.style.transform = 'translateY(0)';
    button.style.boxShadow = '0 2px 10px rgba(255,78,69,.28)';
    button.style.filter = 'none';
  });
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick(event);
  });

  return button;
}

/**
 * 页面入口按钮：挂在 masthead 的 #end 区域，和现有脚本位置保持一致。
 * 用内联样式，避免 YouTube 全局 CSS 干扰。
 */
export async function ensureEntryButton(
  options: EntryButtonOptions & { marginLeft?: string },
): Promise<HTMLElement | null> {
  const { doc, id = ENTRY_BUTTON_ID } = options;
  const selectors = getSelectors();

  let anchor: Element;
  try {
    anchor = await waitForElement(doc, selectors.mastheadEnd, 8000);
  } catch {
    return null;
  }

  doc.getElementById(id)?.remove();

  const button = createEntryButton(options);
  // 与 YouTube 自身按钮排版一致：右侧留出与相邻图标的间距
  button.style.marginLeft = options.marginLeft ?? '10px';
  button.style.alignSelf = 'center';
  anchor.appendChild(button);
  return button;
}

/**
 * 临时把入口按钮文案换成提示，2 秒后复原。
 * 用于「当前页面没有右栏」这类说明：不能弹 alert，也不能再弹一个浮层。
 */
export function flashEntryButton(doc: Document, message: string, ms = 2000): void {
  const button = doc.getElementById(ENTRY_BUTTON_ID);
  const label = button?.querySelector<HTMLElement>('[data-role="label"]');
  if (!button || !label) return;

  const originalLabel = label.textContent ?? '';
  const originalTitle = button.title;
  label.textContent = message;
  button.title = message;

  setTimeout(() => {
    label.textContent = originalLabel;
    button.title = originalTitle;
  }, ms);
}

/** 按 id 移除入口按钮（浮层按钮的 id 与 masthead 的不同）。 */
export function removeEntryButton(doc: Document, id: string = ENTRY_BUTTON_ID): void {
  doc.getElementById(id)?.remove();
}
