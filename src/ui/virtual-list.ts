import { findOffset, h } from './dom';

export interface VirtualListOptions {
  estimate?: number;
  overscan?: number;
  renderRow: (index: number) => HTMLElement;
  /** 用户主动滚动时回调，用于暂停「播放跟随」 */
  onUserScroll?: () => void;
}

export interface VirtualListHandle {
  element: HTMLElement;
  setCount(count: number): void;
  scrollToIndex(index: number, align?: 'center' | 'start'): void;
  scrollToTop(): void;
  /** 容器从隐藏变为可见（或被 resize）后重新测量 */
  relayout(): void;
  /** 已经挂载的行里按原始 index 取节点 */
  mountedRow(index: number): HTMLElement | undefined;
  eachMounted(fn: (index: number, row: HTMLElement) => void): void;
  destroy(): void;
}

/**
 * 1000+ 行字幕的窗口化渲染：只挂可视区 ± overscan 的行，行高实测后回填。
 * 没有虚拟滚动的话，长视频一打开就是上万次 layout。
 */
export function createVirtualList(options: VirtualListOptions): VirtualListHandle {
  const estimate = options.estimate ?? 46;
  const overscan = options.overscan ?? 8;

  const scroller = h('div', { class: 'ytt-scroll h-full overflow-y-auto overflow-x-hidden' });
  const spacer = h('div', { class: 'relative w-full' });
  scroller.appendChild(spacer);

  let count = 0;
  let heights: number[] = [];
  let offsets: number[] = [];
  let frame = 0;

  const mounted = new Map<number, HTMLElement>();

  const recompute = (): void => {
    offsets = new Array(count);
    let total = 0;
    for (let i = 0; i < count; i += 1) {
      offsets[i] = total;
      total += heights[i];
    }
    spacer.style.height = `${total}px`;
  };

  const place = (row: HTMLElement, index: number): void => {
    row.style.transform = `translateY(${offsets[index] ?? 0}px)`;
  };

  const render = (): void => {
    if (count === 0) {
      mounted.forEach((row) => row.remove());
      mounted.clear();
      spacer.style.height = '0px';
      return;
    }

    const viewTop = scroller.scrollTop;
    const viewHeight = scroller.clientHeight || 600;
    const viewBottom = viewTop + viewHeight;

    const first = Math.max(0, findOffset(offsets, viewTop) - overscan);
    const last = Math.min(count - 1, findOffset(offsets, viewBottom) + overscan);

    for (const [index, row] of [...mounted]) {
      if (index < first || index > last) {
        row.remove();
        mounted.delete(index);
      }
    }

    const fresh: HTMLElement[] = [];
    for (let i = first; i <= last; i += 1) {
      if (mounted.has(i)) continue;
      const row = options.renderRow(i);
      row.dataset.index = String(i);
      row.style.position = 'absolute';
      row.style.top = '0';
      row.style.left = '0';
      row.style.right = '0';
      mounted.set(i, row);
      spacer.appendChild(row);
      fresh.push(row);
    }

    let changed = false;
    for (const row of fresh) {
      const index = Number(row.dataset.index);
      const measured = row.offsetHeight;
      if (measured > 0 && Math.abs(measured - heights[index]) > 0.5) {
        heights[index] = measured;
        changed = true;
      }
    }

    if (changed) recompute();
    for (const [index, row] of mounted) place(row, index);
  };

  const schedule = (): void => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      render();
    });
  };

  /**
   * 丢弃已挂载的行并回到估算高度，然后再渲染一次。
   * 面板首次构建时还在离线状态（offsetHeight 为 0），宽度变化后行也会重新折行，
   * 这两种情况都必须重新测量，否则偏移量会一直停在估算值上、行与行重叠。
   */
  const resetAll = (): void => {
    mounted.forEach((row) => row.remove());
    mounted.clear();
    heights = new Array(count).fill(estimate);
    recompute();
    render();
  };

  const onScroll = (): void => schedule();
  const onUserInput = (): void => options.onUserScroll?.();
  scroller.addEventListener('scroll', onScroll, { passive: true });
  scroller.addEventListener('wheel', onUserInput, { passive: true });
  scroller.addEventListener('touchmove', onUserInput, { passive: true });

  let lastWidth = 0;
  const observer =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          const width = scroller.clientWidth;
          if (width !== lastWidth) {
            lastWidth = width;
            resetAll();
            return;
          }
          render();
        })
      : null;
  observer?.observe(scroller);

  return {
    element: scroller,
    setCount(next) {
      if (next === count) return;
      count = next;
      scroller.scrollTop = 0;
      resetAll();
    },
    scrollToIndex(index, align = 'center') {
      if (index < 0 || index >= count) return;
      const top = offsets[index] ?? 0;
      const height = heights[index] ?? estimate;
      const target =
        align === 'center' ? top - Math.max(0, (scroller.clientHeight - height) / 2) : top;
      scroller.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    },
    scrollToTop() {
      scroller.scrollTo({ top: 0, behavior: 'auto' });
    },
    relayout() {
      lastWidth = scroller.clientWidth;
      resetAll();
    },
    mountedRow: (index) => mounted.get(index),
    eachMounted(fn) {
      for (const [index, row] of mounted) fn(index, row);
    },
    destroy() {
      observer?.disconnect();
      if (frame) cancelAnimationFrame(frame);
      scroller.removeEventListener('scroll', onScroll);
      scroller.removeEventListener('wheel', onUserInput);
      scroller.removeEventListener('touchmove', onUserInput);
      mounted.clear();
      scroller.remove();
    },
  };
}
