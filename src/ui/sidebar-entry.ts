import {
  hasNoCaptions,
  setEntryButtonOpen,
  setEntryButtonUnavailable,
} from '../core/dom/button';
import { waitForElement } from '../core/dom/wait';
import type { SitePanelHandle } from '../core/site/types';
import type { TranscriptClient } from '../platform/types';
import { BILI_ENTRY_BUTTON_ID, createFloatButton } from './float-button';
import { createSidebarPanel, type SidebarPanelHandle, type SidebarPanelOptions } from './sidebar';

/**
 * B 站入口按钮放进顶部导航的 `<ul class="right-entry">`，
 * 作为与 `.right-entry-item--upload`（投稿）同级的 `<li>` 插在它前面；
 * 面板仍在右栏 `.right-container-inner`。
 *
 * 用原生 `<li class="right-entry-item">` 外壳承接 B 站自身的 flex/gap，
 * 不给按钮加 fixed / margin 这类样式，避免把 header 布局挤乱。
 */

const UPLOAD_ITEM_SELECTOR = '.right-entry-item--upload';
const WRAPPER_ID = 'ytt-header-entry-item';

export interface SidebarEntryOptions extends SidebarPanelOptions {
  label: string;
}

export function createSidebarWithEntryButton(options: SidebarEntryOptions): SitePanelHandle {
  const { doc, label, currentVideoId, client } = options;
  let sidebar: SidebarPanelHandle;
  sidebar = createSidebarPanel({
    ...options,
    onToggle: (open) => setEntryButtonOpen(doc, open, BILI_ENTRY_BUTTON_ID),
  });

  let button: HTMLButtonElement | null = null;
  let wrapper: HTMLLIElement | null = null;
  let hintTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let watchTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  let observer: MutationObserver | null = null;

  const applyNoCaptions = (): void => {
    setEntryButtonUnavailable(doc, hasNoCaptions(client.getState()), BILI_ENTRY_BUTTON_ID);
  };
  const unsubscribeState = client.subscribe((state) => {
    setEntryButtonUnavailable(doc, hasNoCaptions(state), BILI_ENTRY_BUTTON_ID);
  });
  applyNoCaptions();

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

  /**
   * B 站视频页是 SSR + Vue hydration。hydration 完成前往 SSR 树里插节点，
   * Vue 接管时会把节点连同原生 header 一起冲掉 —— 这正是之前「header 被搞乱」的根因。
   * `[data-server-rendered]` 消失才是可以安全插入的信号。
   */
  const isHydrating = (): boolean => Boolean(doc.querySelector('[data-server-rendered]'));

  function refreshButton(): void {
    if (isHydrating()) return;
    let currentId: string | null = null;
    try {
      currentId = currentVideoId?.() ?? null;
    } catch {
      currentId = null;
    }
    if (!currentId) {
      wrapper?.remove();
      wrapper = null;
      button = null;
      return;
    }

    const upload = doc.querySelector<HTMLElement>(UPLOAD_ITEM_SELECTOR);
    const list = upload?.parentElement;
    if (!upload || !list || !list.classList.contains('right-entry')) {
      // header 还没渲染 / SPA 正在重建：保留 wrapper 引用，下一轮再插
      return;
    }

    if (!wrapper) {
      wrapper = doc.createElement('li');
      wrapper.id = WRAPPER_ID;
      // 与投稿那一项同结构，间距与对齐交给 B 站自己的 .right-entry 样式
      wrapper.className = 'right-entry-item';
      wrapper.style.cssText = 'display:flex;align-items:center;';

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
      button.style.margin = '0';
      wrapper.appendChild(button);
    }

    // 已经在正确位置就别动 DOM：observer 也会调到这里，重复插入会形成循环
    if (wrapper.parentNode === list && wrapper.nextElementSibling === upload) return;

    // 先清掉旧位置（header 重建或历史版本插到别处），再放到投稿左边
    doc.getElementById(WRAPPER_ID)?.remove();
    doc.getElementById(BILI_ENTRY_BUTTON_ID)?.remove();
    list.insertBefore(wrapper, upload);
    if (button && !wrapper.contains(button)) wrapper.appendChild(button);
    setEntryButtonOpen(doc, sidebar.isOpen(), BILI_ENTRY_BUTTON_ID);
    applyNoCaptions();
  }

  function startWatch(): void {
    if (watchTimer !== null) return;
    // document_start 时 header 还没来；SPA 切页也会重建它
    watchTimer = globalThis.setInterval(refreshButton, 600);
  }

  /** hydration 结束、header 被重建时都要重新尝试，不依赖固定延迟 */
  function startObserver(): void {
    if (observer || !doc.documentElement || typeof MutationObserver === 'undefined') return;
    observer = new MutationObserver(() => refreshButton());
    observer.observe(doc.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-server-rendered'],
    });
  }

  void waitForElement(doc, UPLOAD_ITEM_SELECTOR, 8000)
    .then(refreshButton)
    .catch(() => undefined);
  startWatch();
  startObserver();

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
      if (watchTimer !== null) globalThis.clearInterval(watchTimer);
      if (hintTimer !== null) globalThis.clearTimeout(hintTimer);
      observer?.disconnect();
      watchTimer = null;
      hintTimer = null;
      observer = null;
      sidebar.destroy();
      wrapper?.remove();
      wrapper = null;
      button = null;
    },
  };
}
