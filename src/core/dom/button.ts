import { getSelectors } from './selectors';
import { waitForElement } from './wait';

export const ENTRY_BUTTON_ID = 'ytt-entry-btn';
/** 1.x 原版按钮沿用它自己的 id，方便和原脚本对照 */
export const LEGACY_BUTTON_ID = 'copy-transcript-btn';

export interface EntryButtonOptions {
  doc: Document;
  label?: string;
  title?: string;
  id?: string;
  /** primary = 红色渐变（新版）；ghost = 描边中性色（原版对比） */
  variant?: 'primary' | 'ghost';
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
  const { doc, label = 'Transcript', onClick, id = ENTRY_BUTTON_ID, variant = 'primary' } = options;
  const version = typeof __YTT_VERSION__ === 'string' ? __YTT_VERSION__ : 'dev';
  const title = options.title ?? `打开字幕面板 · v${version}`;
  const primary = variant === 'primary';
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
    primary ? 'border:1px solid rgba(255,255,255,0.14)' : 'border:1px solid currentColor',
    'border-radius:999px',
    primary ? 'background:linear-gradient(135deg,#ff4e45,#ff7a45)' : 'background:transparent',
    // ghost 跟随 masthead 的文字色：浅色主题下是深字，深色主题下是浅字
    primary ? 'color:#fff' : 'color:inherit',
    primary ? '' : 'opacity:.85',
    'font-family:Inter,"PingFang SC",system-ui,sans-serif',
    'font-size:13px',
    'font-weight:600',
    'letter-spacing:.2px',
    'cursor:pointer',
    primary ? 'box-shadow:0 2px 10px rgba(255,78,69,.28)' : 'box-shadow:none',
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
    button.style.boxShadow = primary ? '0 6px 18px rgba(255,78,69,.4)' : '0 4px 12px rgba(0,0,0,.35)';
    button.style.filter = 'brightness(1.05)';
  });
  button.addEventListener('mouseleave', () => {
    button.style.transform = 'translateY(0)';
    button.style.boxShadow = primary ? '0 2px 10px rgba(255,78,69,.28)' : 'none';
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

export function removeEntryButton(doc: Document): void {
  // 只删我们自己的按钮：copy-transcript-btn 由逐字节内联的 1.x 原版脚本自己管理
  doc.getElementById(ENTRY_BUTTON_ID)?.remove();
}
