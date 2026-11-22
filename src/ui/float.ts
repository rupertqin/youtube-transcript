import type { SitePanelHandle } from '../core/site/types';
import type { TranscriptClient } from '../platform/types';
import { createFloatButton } from './float-button';
import { createPanel, type PanelHandle } from './panel';

/**
 * 右下角浮层挂载点（B 站这类没有「右栏卡片位」的站点）。
 *
 * 和 `sidebar.ts` 是同一位置的两种实现：
 *  - 入口按钮 + 面板都塞进 **shadow root**：两个站点的全局 CSS 都很凶，
 *    只有 shadow 能做到双向隔离；
 *  - 面板高度必须显式给（virtual-list 用 clientHeight 做窗口化）；
 *  - 展开状态存 sessionStorage，切视频不重置，换站点互不影响（key 带站点）。
 */

export const FLOAT_HOST_ID = 'ytt-float-host';

/** 浮层卡片高度：和右栏卡片同量级，窄屏下退到 66vh。 */
const FLOAT_HEIGHT = 'min(560px, 72vh)';

export interface FloatPanelOptions {
  doc: Document;
  css: string;
  client: TranscriptClient;
  currentVideoId?: () => string | null;
  /** 入口按钮文案（YouTube='Transcript' / B站='字幕'） */
  label: string;
  /** 展开状态存哪个 key（按站点分开） */
  storageKey: string;
  /** 浮层默认收起：一进页面就挡住视频很烦 */
  defaultOpen?: boolean;
}

export interface FloatPanelHandle extends SitePanelHandle {
  /** 宿主是否已经挂在文档里 */
  hasMount(): boolean;
}

export function createFloatPanel(options: FloatPanelOptions): FloatPanelHandle {
  const { doc, css, client, label, storageKey } = options;
  const win = doc.defaultView as (Window & typeof globalThis) | null;
  const defaultOpen = options.defaultOpen ?? false;

  let host: HTMLElement | null = null;
  let panel: PanelHandle | null = null;
  let open = readOpen();

  function readOpen(): boolean {
    try {
      const raw = win?.sessionStorage?.getItem(storageKey);
      if (raw === '1') return true;
      if (raw === '0') return false;
    } catch {
      /* 隐私模式下 sessionStorage 可能抛错 */
    }
    return defaultOpen;
  }

  function writeOpen(next: boolean): void {
    try {
      win?.sessionStorage?.setItem(storageKey, next ? '1' : '0');
    } catch {
      /* 写不进去不影响本次会话 */
    }
  }

  function raf(cb: () => void): void {
    if (win?.requestAnimationFrame) win.requestAnimationFrame(() => cb());
    else setTimeout(cb, 0);
  }

  function buildHost(): HTMLElement {
    const el = doc.createElement('div');
    el.id = FLOAT_HOST_ID;
    // 容器本身不吃鼠标事件，只有按钮和卡片吃 —— 否则右下角会莫名其妙挡点击
    el.style.cssText = [
      'position:fixed',
      'right:16px',
      'bottom:16px',
      'z-index:2147483000',
      'display:flex',
      'flex-direction:column',
      'align-items:flex-end',
      'gap:10px',
      'pointer-events:none',
    ].join(';');

    const shadow = el.attachShadow({ mode: 'open' });
    const style = doc.createElement('style');
    style.textContent = css;
    shadow.appendChild(style);

    const button = createFloatButton({
      doc,
      label,
      onClick: () => {
        if (open) hide();
        else show();
      },
    });
    shadow.appendChild(button);
    return el;
  }

  function ensurePanel(): PanelHandle {
    if (panel) {
      const root = host?.shadowRoot;
      // 宿主被站点重建过时，shadow root 是新的，面板元素还挂在旧的（已脱离文档）root 里
      if (root && panel.element.parentNode !== root) {
        root.appendChild(panel.element);
        raf(() => panel?.relayout());
      }
      return panel;
    }

    panel = createPanel({
      client,
      variant: 'overlay',
      onClose: () => hide(),
      currentVideoId: options.currentVideoId,
    });
    panel.element.classList.add('ytt-card', 'ytt-float');
    panel.element.style.setProperty('--ytt-card-height', FLOAT_HEIGHT);
    host!.shadowRoot!.appendChild(panel.element);
    panel.element.style.display = 'none';
    return panel;
  }

  function ensureMounted(): boolean {
    if (!doc.body) return false;
    if (!host) host = buildHost();
    if (!host.isConnected) doc.body.appendChild(host);
    return true;
  }

  function show(): boolean {
    if (!ensureMounted()) return false;
    open = true;
    writeOpen(true);
    const view = ensurePanel();
    view.element.style.display = 'flex';
    raf(() => view.relayout());
    return true;
  }

  function hide(): void {
    open = false;
    writeOpen(false);
    if (panel) panel.element.style.display = 'none';
  }

  // 初始状态：展开过就恢复；否则只有按钮
  if (open) show();

  return {
    ensureMounted() {
      const mounted = ensureMounted();
      if (mounted && open) {
        const view = ensurePanel();
        view.element.style.display = 'flex';
      }
      return mounted;
    },
    show,
    hide,
    toggle() {
      if (open) {
        hide();
        return false;
      }
      return show();
    },
    isOpen: () => open && Boolean(panel?.element.isConnected),
    hasMount: () => Boolean(doc.body) && Boolean(host?.isConnected),
    destroy() {
      panel?.destroy();
      panel = null;
      host?.remove();
      host = null;
    },
  };
}
