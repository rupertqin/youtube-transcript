import { readVideoId } from '../core/harvest/player';
import type { TranscriptClient } from '../platform/types';
import { createPanel, type PanelHandle } from './panel';

/**
 * 页面内面板的第三种形态：**嵌进 YouTube 观看页右栏**（相关视频那一列），
 * 而不是浮在视频上。
 *
 * 为什么不做浮层：
 *  - 浮层会挡住视频和控制条；
 *  - YouTube 自己的字幕面板就在右栏，跟着右栏走才像「原生」；
 *  - 页面滚动时面板随页面移动，不需要自己算位置。
 *
 * 两个硬约束：
 *  1. 卡片高度必须显式给。virtual-list 用 scroller.clientHeight 做窗口化，
 *     高度为 0 时会回落到 600px 估算，行高全错。
 *  2. YouTube 在 SPA 切页/布局切换时会重建 #secondary-inner，
 *     宿主节点会脱离文档，必须能自动重新挂回去（且保持展开状态）。
 */

export const SIDEBAR_HOST_ID = 'ytt-sidebar-host';

/**
 * 面板元素是否需要挪进（新的）shadow root。
 *
 * YouTube 重建 `#secondary-inner` 时会把我们的宿主一起摘掉，新建的 shadow root
 * 是空的，而面板元素还留在旧的、已脱离文档的 root 里 —— 只补挂宿主不挪面板，
 * 用户看到的是一张空白卡片。
 */
export function panelNeedsRemount(
  child: Node | null | undefined,
  root: Node | null | undefined,
): boolean {
  if (!root) return false;
  return child?.parentNode !== root;
}

/**
 * 除 keep 之外的多余宿主。
 *
 * YouTube 保留上一页 DOM 快照时页面上会同时存在多个我们的宿主，
 * 其中一个里面的面板可能永远不再更新 —— 必须清掉。
 */
export function duplicateHosts(all: ArrayLike<Element>, keep: Element | null): Element[] {
  const extra: Element[] = [];
  for (const node of Array.from(all)) {
    if (node !== keep) extra.push(node);
  }
  return extra;
}

/** 展开态卡片高度：右栏约 400px 宽，560px 高约能显示 12 行。 */
// 排版放松后（工具栏两行 106px、每条字幕带独立时间行）纵向多占近 100px，
// 同步把卡片加高，保证首屏仍能看到足够多的字幕块。
const EXPANDED_HEIGHT = 'min(660px, 78vh)';
/** 折叠态只留标题栏。 */

/** 记住展开状态的键。用 sessionStorage：同一个标签页内切视频要保持打开。 */
const OPEN_KEY = 'ytt-sidebar-open';

/**
 * 找右栏挂载点。
 *
 * 只在观看页挂载：`ytd-watch-flexy` 是视频页独有的宿主元素，
 * 首页/搜索页/频道页即便碰巧有 #secondary 也不该插卡片。
 */
export function resolveSidebarMount(doc: Document): HTMLElement | null {
  const watch = doc.querySelector('ytd-watch-flexy');
  if (watch) {
    for (const selector of ['#secondary-inner', '#secondary']) {
      const el = doc.querySelector<HTMLElement>(selector);
      if (el) return el;
      // 有些实验版把右栏塞在 watch-flexy 内部的其他位置
      const inner = watch.querySelector<HTMLElement>(selector);
      if (inner) return inner;
    }
    return null;
  }

  // B 站普通 UP 主视频页：相关推荐那一列。
  // 只认这几个明确的选择器，宽屏/影院等没有右栏的布局会返回 null，
  // 由站点适配器退回右下浮层，不去改站点布局。
  const vdcon = doc.querySelector('#mirror-vdcon');
  const right =
    vdcon?.querySelector<HTMLElement>('.right-container') ??
    doc.querySelector<HTMLElement>('.video-container-v1 .right-container') ??
    doc.querySelector<HTMLElement>('.right-container');
  if (!right) return null;
  return right.querySelector<HTMLElement>('.right-container-inner') ?? right;
}

export interface SidebarPanelOptions {
  doc: Document;
  css: string;
  client: TranscriptClient;
  /** 展开状态变化，入口按钮据此同步文案 */
  onToggle?: (open: boolean) => void;
  /** 地址栏当前视频；不传则从 doc.defaultView 读 */
  currentVideoId?: () => string | null;
  /** 卡片高度；B 站右栏比 YouTube 窄，站点适配器会传更矮的值 */
  height?: string;
}

export interface SidebarPanelHandle {
  /**
   * 确保宿主还在文档里。YouTube 重建右栏后调用它就能挂回去。
   * 返回 false 表示当前页面没有右栏（Shorts、无相关视频列等）。
   */
  ensureMounted(): boolean;
  /** 展开；没有右栏时返回 false，由调用方给非阻塞提示 */
  show(): boolean;
  hide(): void;
  toggle(): boolean;
  isOpen(): boolean;
  hasMount(): boolean;
  destroy(): void;
}

export function createSidebarPanel(options: SidebarPanelOptions): SidebarPanelHandle {
  const { doc, css, client, onToggle } = options;
  const win = doc.defaultView as (Window & typeof globalThis) | null;

  // 面板用它对账「自己显示的是不是当前视频」
  const currentVideoId = options.currentVideoId ?? (() => (win ? readVideoId(win) : null));

  let host: HTMLElement | null = null;
  let panel: PanelHandle | null = null;
  let open = readOpen();
  let watchTimer = 0;
  let observer: MutationObserver | null = null;
  /** 上一轮轮询时地址栏的视频，用来发现「页面换了视频」 */
  let lastPageId: string | null = null;

  function readOpen(): boolean {
    try {
      const raw = win?.sessionStorage?.getItem(OPEN_KEY);
      if (raw === '0') return false;
      if (raw === '1') return true;
    } catch {
      /* 隐私模式下 sessionStorage 可能抛错 */
    }
    // 默认展开：用户点开过面板就说明他要看，切页不该把它收起来
    return true;
  }

  function writeOpen(next: boolean): void {
    try {
      win?.sessionStorage?.setItem(OPEN_KEY, next ? '1' : '0');
    } catch {
      /* 写不进去不影响本次会话 */
    }
  }

  /** 下一帧再测量：刚插进 DOM 时 clientHeight 还是 0 */
  function raf(cb: () => void): void {
    if (win?.requestAnimationFrame) win.requestAnimationFrame(() => cb());
    else setTimeout(cb, 0);
  }

  function buildHost(): HTMLElement {
    const el = doc.createElement('div');
    el.id = SIDEBAR_HOST_ID;
    // 宽度交给右栏，margin-bottom 与下方「相关视频」拉开距离
    el.style.cssText = 'display:block;width:100%;margin:0 0 12px 0;';
    const shadow = el.attachShadow({ mode: 'open' });
    const style = doc.createElement('style');
    style.textContent = css;
    shadow.appendChild(style);
    return el;
  }

  function ensurePanel(): PanelHandle {
    if (panel) {
      // 宿主可能刚被 YouTube 重建：新的 shadow root 是空的，
      // 面板元素还挂在旧的（已脱离文档）root 里。必须挪回来，
      // 否则页面上会出现一张空白卡片。
      const root = host?.shadowRoot;
      if (root && panelNeedsRemount(panel.element, root)) {
        root.appendChild(panel.element);
        raf(() => panel?.relayout());
      }
      return panel;
    }

    panel = createPanel({
      client,
      variant: 'sidebar',
      onClose: () => hide(),
      currentVideoId,
    });
    // 卡片样式挂在面板根节点上：.ytt-root 自己定义了颜色变量，
    // 放在外层容器上会拿不到（浅色主题也切不过去）。
    panel.element.classList.add('ytt-card');
    panel.element.style.setProperty('--ytt-card-height', options.height ?? EXPANDED_HEIGHT);
    host!.shadowRoot!.appendChild(panel.element);
    return panel;
  }

  /**
   * YouTube 保留上一页 DOM 快照时，页面上可能同时存在多个我们的宿主。
   * 只留当前这一个，其余连同里面的旧面板一起摘掉 —— 否则用户可能看到
   * 一张永远不更新的、属于上一个视频的卡片。
   */
  function dropDuplicateHosts(): void {
    if (!host) return;
    const extra = duplicateHosts(doc.querySelectorAll(`#${SIDEBAR_HOST_ID}`), host);
    for (const node of extra) node.remove();
  }

  function ensureMounted(): boolean {
    // 首次挂载可能在 document_start：右栏还没渲染出来。
    // 这里先把兜底轮询开起来，即使这次挂不上，后续也会自动补挂。
    if (open) startWatch();

    const mount = resolveSidebarMount(doc);
    if (!mount) {
      // 离开观看页（或这条视频没有右栏）：把宿主摘掉，面板实例留着，
      // 回到有右栏的页面能立刻恢复，不用重建几万行的索引。
      if (host?.parentNode) host.parentNode.removeChild(host);
      return false;
    }

    const fresh = !host || host.parentNode !== mount;
    if (!host) host = buildHost();
    if (host.parentNode !== mount) {
      // 插到右栏最上面，压住「相关视频」标题，视觉上就是 YouTube 的板块
      mount.insertBefore(host, mount.firstChild);
    }

    dropDuplicateHosts();

    if (open) {
      // 展开态：宿主可能是刚重建的，面板实例要重新塞回 shadow
      ensurePanel();
      host.style.display = 'block';
      // 刚进 DOM 时 clientHeight 还是 0，等下一帧再量
      if (fresh) raf(() => panel?.relayout());
      startWatch();
    } else {
      host.style.display = 'none';
    }
    return true;
  }

  function show(): boolean {
    if (!ensureMounted()) return false;
    const first = !panel;
    open = true;
    writeOpen(true);
    ensurePanel();
    host!.style.display = 'block';
    if (first) raf(() => panel?.relayout());
    else panel?.relayout();
    onToggle?.(true);
    startWatch();
    return true;
  }

  function hide(): void {
    open = false;
    writeOpen(false);
    if (host) host.style.display = 'none';
    onToggle?.(false);
  }

  /**
   * 轮询兜底。
   *
   * 两件事：①YouTube 重建右栏时宿主会被一起摘掉，需要补挂；
   * ②地址栏换了视频时立刻重画面板 —— 新鲜度闸门因此不依赖 store 通知，
   * 即使会话层因任何原因慢了一拍，界面上也不会继续显示上一个视频的字幕。
   */
  function startWatch(): void {
    if (watchTimer || !win) return;
    lastPageId = currentVideoId();

    // YouTube 重建右栏时会把我们的宿主一起摘掉。只靠 600ms 轮询的话，
    // 卡片会在页面上消失半秒再长回来 —— 用户看到的就是「闪一下」。
    // 这里用 MutationObserver：摘掉后**下一个任务就补挂**，只剩一帧空窗。
    const Observer = (win as Window & typeof globalThis).MutationObserver;
    if (Observer && !observer && doc.documentElement) {
      observer = new Observer(() => {
        if (open && (!host || !host.isConnected)) ensureMounted();
      });
      observer.observe(doc.documentElement, { childList: true, subtree: true });
    }

    watchTimer = win.setInterval(() => {
      if (!open) return;

      const pageId = currentVideoId();
      if (pageId !== lastPageId) {
        lastPageId = pageId;
        panel?.refresh();
      }

      if (!host || !host.isConnected) ensureMounted();
    }, 600);
  }

  return {
    ensureMounted() {
      const mounted = ensureMounted();
      if (mounted && open) startWatch();
      return mounted;
    },
    show,
    hide,
    toggle() {
      if (open && host?.style.display !== 'none') {
        hide();
        return false;
      }
      return show();
    },
    isOpen: () => open && Boolean(host?.isConnected),
    hasMount: () => resolveSidebarMount(doc) !== null,
    destroy() {
      if (watchTimer && win) win.clearInterval(watchTimer);
      watchTimer = 0;
      observer?.disconnect();
      observer = null;
      panel?.destroy();
      panel = null;
      host?.remove();
      host = null;
    },
  };
}
