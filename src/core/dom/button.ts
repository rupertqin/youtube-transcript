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

  const rows: Array<[number, number]> = [
    [5, 11],
    [9, 11],
    [13, 7],
  ];
  for (const [y, width] of rows) {
    const rect = doc.createElementNS(ns, 'rect');
    rect.setAttribute('x', '4');
    rect.setAttribute('y', String(y - 1));
    rect.setAttribute('width', String(width));
    rect.setAttribute('height', '2');
    rect.setAttribute('rx', '1');
    rect.setAttribute('fill', 'currentColor');
    svg.appendChild(rect);
  }
  return svg;
}

/**
 * 页面入口按钮：挂在 masthead 的 #end 区域，和现有脚本位置保持一致。
 * 用内联样式，避免 YouTube 全局 CSS 干扰。
 */
export async function ensureEntryButton(options: EntryButtonOptions): Promise<HTMLElement | null> {
  const { doc, label = 'Transcript', onClick, id = ENTRY_BUTTON_ID } = options;
  const version = typeof __YTT_VERSION__ === 'string' ? __YTT_VERSION__ : 'dev';
  const title = options.title ?? `打开字幕面板 · v${version}`;
  const badgeText = options.badge === undefined ? `v${version}` : options.badge;
  const selectors = getSelectors();

  let anchor: Element;
  try {
    anchor = await waitForElement(doc, selectors.mastheadEnd, 8000);
  } catch {
    return null;
  }

  doc.getElementById(id)?.remove();

  const button = doc.createElement('button');
  button.id = id;
  button.type = 'button';
  button.title = title;
  button.setAttribute('aria-label', title);
  button.style.cssText = [
    'display:inline-flex',
    'align-items:center',
    'gap:6px',
    'margin-left:10px',
    'height:34px',
    'padding:0 12px',
    'border:1px solid rgba(255,255,255,0.14)',
    'border-radius:999px',
    'background:linear-gradient(135deg,#ff4e45,#ff7a45)',
    'color:#fff',
    // 与 YouTube 自身的按钮排版一致，别让入口按钮一眼看出是外挂
    'font-family:Roboto,Arial,sans-serif',
    'font-size:14px',
    'font-weight:500',
    'cursor:pointer',
    'box-shadow:0 2px 10px rgba(255,78,69,.28)',
    'transition:transform .16s ease,box-shadow .16s ease,filter .16s ease',
    'align-self:center',
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

export function removeEntryButton(doc: Document): void {
  // 页面上只有这一个入口按钮
  doc.getElementById(ENTRY_BUTTON_ID)?.remove();
}
