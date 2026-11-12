import type { TranscriptClient } from '../platform/types';
import { createPanel, type PanelHandle } from './panel';

export const OVERLAY_HOST_ID = 'ytt-overlay-host';

const HOST_STYLE = [
  'position: fixed',
  'top: 76px',
  'right: 16px',
  'width: 380px',
  'height: min(620px, calc(100vh - 100px))',
  'z-index: 2147483000',
  'display: none',
  'padding: 0',
  'margin: 0',
  'border: 0',
].join(';');

export interface OverlayOptions {
  doc: Document;
  css: string;
  client: TranscriptClient;
  onToggle?: (open: boolean) => void;
}

export interface OverlayHandle {
  show(): void;
  hide(): void;
  toggle(): void;
  isOpen(): boolean;
  destroy(): void;
}

/**
 * 页面内浮层：挂到 Shadow DOM 里，避免 YouTube 的全局 CSS 污染面板。
 * 面板结构本身由 panel.ts 用原生 DOM 构建，这里只负责画布与显隐。
 */
export function createOverlay(options: OverlayOptions): OverlayHandle {
  const { doc, css, client, onToggle } = options;

  const host = doc.createElement('div');
  host.id = OVERLAY_HOST_ID;
  host.style.cssText = HOST_STYLE;

  const shadow = host.attachShadow({ mode: 'open' });
  const style = doc.createElement('style');
  style.textContent = css;
  shadow.appendChild(style);

  const card = doc.createElement('div');
  card.style.cssText =
    'height:100%;overflow:hidden;border-radius:14px;border:1px solid var(--ytt-border);' +
    'background:var(--ytt-bg);box-shadow:var(--ytt-shadow)';
  shadow.appendChild(card);

  let panel: PanelHandle | null = null;
  let open = false;

  const attach = (): void => {
    if (!host.isConnected) (doc.body ?? doc.documentElement).appendChild(host);
  };

  const ensurePanel = (): PanelHandle => {
    if (!panel) {
      panel = createPanel({ client, variant: 'overlay', onClose: () => hide() });
      card.appendChild(panel.element);
      card.classList.add('ytt-enter');
    }
    return panel;
  };

  const show = (): void => {
    if (open) return;
    open = true;
    attach();
    ensurePanel();
    host.style.display = 'block';
    panel?.relayout();
    onToggle?.(true);
  };

  const hide = (): void => {
    if (!open) return;
    open = false;
    host.style.display = 'none';
    onToggle?.(false);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !open) return;
    if (!event.composedPath().includes(host)) return;
    // 搜索框里的 Esc 归工具栏处理（清空搜索），不要连面板一起关掉
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    hide();
  };
  doc.addEventListener('keydown', onKeyDown);

  return {
    show,
    hide,
    toggle: () => (open ? hide() : show()),
    isOpen: () => open,
    destroy() {
      doc.removeEventListener('keydown', onKeyDown);
      panel?.destroy();
      host.remove();
    },
  };
}
