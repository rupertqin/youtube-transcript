import { getSelectors } from './selectors';
import { waitForElement } from './wait';

export const ENTRY_BUTTON_ID = 'ytt-entry-btn';

export interface EntryButtonOptions {
  doc: Document;
  label?: string;
  title?: string;
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
  const { doc, label = 'Transcript', title = 'Open transcript panel', onClick } = options;
  const selectors = getSelectors();

  let anchor: Element;
  try {
    anchor = await waitForElement(doc, selectors.mastheadEnd, 8000);
  } catch {
    return null;
  }

  doc.getElementById(ENTRY_BUTTON_ID)?.remove();

  const button = doc.createElement('button');
  button.id = ENTRY_BUTTON_ID;
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
    'font-family:Inter,"PingFang SC",system-ui,sans-serif',
    'font-size:13px',
    'font-weight:600',
    'letter-spacing:.2px',
    'cursor:pointer',
    'box-shadow:0 2px 10px rgba(255,78,69,.28)',
    'transition:transform .16s ease,box-shadow .16s ease,filter .16s ease',
    'align-self:center',
  ].join(';');

  button.appendChild(buildIcon(doc));
  const text = doc.createElement('span');
  text.textContent = label;
  button.appendChild(text);

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

export function removeEntryButton(doc: Document): void {
  doc.getElementById(ENTRY_BUTTON_ID)?.remove();
}
