import type { PanelState } from '../types';
import { getSelectors } from './selectors';
import { waitForElement } from './wait';

export const ENTRY_BUTTON_ID = 'ytt-entry-btn';

export interface EntryButtonOptions {
  doc: Document;
  label?: string;
  title?: string;
  id?: string;
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

  // 与扩展图标同一个标记：小篆「字」—— 宀 + 子（圆头、张臂、曲身）
  const mark = doc.createElementNS(ns, 'path');
  mark.setAttribute(
    'd',
    [
      'M10 1.8 Q9.6 2.4 10 3',
      'M4.2 9 L4.2 7.8 Q4.2 6.8 5.4 6.8 L14.6 6.8 Q15.8 6.8 15.8 7.8 L15.8 9',
      'M10 11 C10.2 13.6 9.8 15.6 10 17',
      'M10 17 C10 17.8 9 18 8 17.8 L7.2 17.4',
      'M5.2 15.2 Q10 15.8 14.8 15.2',
    ].join(' '),
  );
  mark.setAttribute('stroke', 'currentColor');
  mark.setAttribute('stroke-width', '1.7');
  mark.setAttribute('stroke-linecap', 'round');
  mark.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(mark);

  // 子的大头：小篆保留的婴儿头部，和两条横线拉开区别，不会读成「宇」
  const head = doc.createElementNS(ns, 'ellipse');
  head.setAttribute('cx', '10');
  head.setAttribute('cy', '12.4');
  head.setAttribute('rx', '1.7');
  head.setAttribute('ry', '1.4');
  head.setAttribute('fill', 'none');
  head.setAttribute('stroke', 'currentColor');
  head.setAttribute('stroke-width', '1.7');
  svg.appendChild(head);
  return svg;
}

/** 展开 / 收起指示箭头；收起时朝下，展开时由 `setEntryButtonOpen` 翻转。 */
function buildChevron(doc: Document): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('data-role', 'chevron');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.transition = 'transform .16s ease';

  const path = doc.createElementNS(ns, 'path');
  path.setAttribute('d', 'M4 6 L8 10 L12 6');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.8');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
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
  const title = options.title ?? `展开 / 收起${label}`;

  const button = doc.createElement('button');
  button.id = id;
  button.type = 'button';
  button.title = title;
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-expanded', 'false');
  button.style.cssText = [
    'display:inline-flex',
    'align-items:center',
    'gap:4px',
    'height:34px',
    'padding:0 10px',
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

  // 只放 logo + 展开/收起箭头，不放文案和版本号
  button.appendChild(buildIcon(doc));
  button.appendChild(buildChevron(doc));

  button.addEventListener('mouseenter', () => {
    if (button.dataset.yttNoSub === '1') return;
    button.style.transform = 'translateY(-1px)';
    button.style.boxShadow = '0 6px 18px rgba(255,78,69,.4)';
    button.style.filter = 'brightness(1.05)';
  });
  button.addEventListener('mouseleave', () => {
    button.style.transform = 'translateY(0)';
    button.style.filter = 'none';
    if (button.dataset.yttNoSub === '1') return;
    button.style.boxShadow = '0 2px 10px rgba(255,78,69,.28)';
  });
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick(event);
  });

  return button;
}

/** 同步展开/收起指示：箭头朝下=可展开，朝上=可收起。 */
export function setEntryButtonOpen(
  doc: Document,
  open: boolean,
  id: string = ENTRY_BUTTON_ID,
): void {
  const button = doc.getElementById(id);
  if (!button) return;
  button.setAttribute('aria-expanded', String(open));
  const chevron = button.querySelector<SVGElement>('[data-role="chevron"]');
  if (chevron) chevron.style.transform = open ? 'rotate(180deg)' : 'none';
}

/** 抓取结束且确定没有字幕时才置灰；加载中/失败但可能有轨都保持原色。 */
export function hasNoCaptions(state: PanelState): boolean {
  if (state.status === 'error') return state.error?.code === 'NO_CAPTION_TRACK';
  return (
    state.status === 'ready' &&
    state.lines.length === 0 &&
    state.availableLangs.length === 0
  );
}

/** 无字幕视频的入口按钮改成浅灰；按钮仍可点开看诊断信息。 */
export function setEntryButtonUnavailable(
  doc: Document,
  unavailable: boolean,
  id: string = ENTRY_BUTTON_ID,
): void {
  const button = doc.getElementById(id);
  if (!(button instanceof HTMLElement)) return;
  button.dataset.yttNoSub = unavailable ? '1' : '0';
  if (unavailable) {
    button.style.background = 'linear-gradient(135deg,#e6e9ed,#cdd2d9)';
    button.style.color = '#6b7178';
    button.style.boxShadow = '0 2px 8px rgba(0,0,0,.08)';
  } else {
    // 显式写回初值：style.background='' 会把 cssText 里的渐变也一起清掉
    button.style.background = 'linear-gradient(135deg,#ff4e45,#ff7a45)';
    button.style.color = '#fff';
    button.style.boxShadow = '0 2px 10px rgba(255,78,69,.28)';
  }
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
  if (!button) return;

  const originalTitle = button.title;
  const originalLabel = button.getAttribute('aria-label');
  // 按钮本身只放 logo，提示走 title / aria-label，不往里塞可见文案
  button.title = message;
  button.setAttribute('aria-label', message);

  setTimeout(() => {
    button.title = originalTitle;
    if (originalLabel !== null) button.setAttribute('aria-label', originalLabel);
  }, ms);
}

/** 按 id 移除入口按钮（浮层按钮的 id 与 masthead 的不同）。 */
export function removeEntryButton(doc: Document, id: string = ENTRY_BUTTON_ID): void {
  doc.getElementById(id)?.remove();
}

/**
 * 入口按钮该做什么：移除 / 保留 / 新建。
 *
 * 「按钮只出现在有视频的页面」这条规则就落在这里 —— 首页、搜索页、频道页
 * 没有 `?v=`，动作恒为 remove；按钮被站点重建 masthead 冲掉（不在文档里）时
 * 必须重建，否则就是「刷新一次才看到按钮」。
 *
 * 抽成纯函数是为了能直接单测这条规则本身（DOM 挂载在 node 里没法跑）。
 */
export type EntryButtonAction = 'remove' | 'keep' | 'insert';

export function entryButtonAction(input: {
  /** 地址栏此刻有视频 id */
  hasVideo: boolean;
  /** 页面上现有的按钮；已被站点摘掉时调用方传 null */
  button: Element | null;
}): EntryButtonAction {
  if (!input.hasVideo) return 'remove';
  if (!input.button || input.button.isConnected !== true) return 'insert';
  return 'keep';
}
