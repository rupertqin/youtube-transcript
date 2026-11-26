import {
  hasNoCaptions,
  setEntryButtonOpen,
  setEntryButtonUnavailable,
} from '../core/dom/button';
import type { SitePanelHandle } from '../core/site/types';
import { BILI_ENTRY_BUTTON_ID, createFloatButton } from './float-button';
import { createSidebarPanel, SIDEBAR_HOST_ID, type SidebarPanelOptions } from './sidebar';

/**
 * B 站入口按钮：右栏里、**卡片（字幕框）正上方**。
 *
 * 不放页头：页头在 `#app` 的 Vue 树里，SSR + hydration 期间插 `<li>` 会让
 * B 站自己的 app 抛 `HierarchyRequestError`，页头连同登录态一起失效。
 * 跟着卡片宿主走，宿主出现就意味着插入时机已经安全（见 `canInsert`）。
 */

const BUTTON_MOUNT_ID = 'ytt-float-mount';

export interface SidebarEntryOptions extends SidebarPanelOptions {
  label: string;
}

export function createSidebarWithEntryButton(options: SidebarEntryOptions): SitePanelHandle {
  const { doc, label, client } = options;
  const sidebar = createSidebarPanel({
    ...options,
    onToggle: (open) => setEntryButtonOpen(doc, open, BILI_ENTRY_BUTTON_ID),
  });

  let button: HTMLButtonElement | null = null;
  /** 按钮容器：插在卡片宿主正上方 */
  let mount: HTMLElement | null = null;
  let hintTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

  const unsubscribeState = client.subscribe((state) => {
    setEntryButtonUnavailable(doc, hasNoCaptions(state), BILI_ENTRY_BUTTON_ID);
  });

  const flashNoSidebar = (): void => {
    if (!button) return;
    const original = button.title;
    button.title = '当前页面没有右栏';
    if (hintTimer !== null) globalThis.clearTimeout(hintTimer);
    hintTimer = globalThis.setTimeout(() => {
      if (button) button.title = original;
      hintTimer = null;
    }, 1800);
  };

  function refreshButton(): void {
    const host = doc.getElementById(SIDEBAR_HOST_ID);
    if (!host?.parentNode) {
      // 卡片还没挂上（右栏未就绪 / 站点框架还没就位）：按钮不单独留在页面上
      mount?.remove();
      return;
    }

    if (!mount) {
      mount = doc.createElement('div');
      mount.id = BUTTON_MOUNT_ID;
      // 上边距与卡片的 topGap 对齐：按钮不要顶着右栏顶边
      mount.style.cssText = 'display:flex;align-items:center;margin:12px 0 8px 0;';
      button = createFloatButton({
        doc,
        label,
        onClick: () => {
          if (sidebar.isOpen()) {
            sidebar.hide();
            return;
          }
          if (!sidebar.show()) flashNoSidebar();
        },
      });
      mount.appendChild(button);
      // 首帧同步一次；之后跟着 store 与 onToggle 走
      setEntryButtonUnavailable(doc, hasNoCaptions(client.getState()), BILI_ENTRY_BUTTON_ID);
      setEntryButtonOpen(doc, sidebar.isOpen(), BILI_ENTRY_BUTTON_ID);
    }

    const container = host.parentNode as HTMLElement;
    // 已经在正确位置就别动 DOM：轮询每轮都会走到这里
    if (mount.parentNode !== container || mount.nextElementSibling !== host) {
      container.insertBefore(mount, host);
    }
  }

  // document_start 时右栏还没来；SPA 切页也会重建它
  const watchTimer = globalThis.setInterval(refreshButton, 600);
  refreshButton();

  return {
    ensureMounted() {
      const mounted = sidebar.ensureMounted();
      refreshButton();
      return mounted;
    },
    show: () => sidebar.show(),
    hide: () => sidebar.hide(),
    toggle: () => sidebar.toggle(),
    isOpen: () => sidebar.isOpen(),
    destroy() {
      unsubscribeState();
      globalThis.clearInterval(watchTimer);
      if (hintTimer !== null) globalThis.clearTimeout(hintTimer);
      hintTimer = null;
      sidebar.destroy();
      mount?.remove();
      mount = null;
      button = null;
    },
  };
}
