import { describe, expect, it } from 'vitest';
import { resolveSidebarMount, SIDEBAR_HOST_ID } from '../src/ui/sidebar';

/**
 * 右栏挂载点解析：决定了面板是「卡片」还是「浮层」。
 * 这里只测纯函数部分，不碰 Shadow DOM 与面板渲染。
 */

type AnyEl = Record<string, unknown>;

function el(children: Record<string, unknown> = {}): HTMLElement {
  return {
    querySelector: (selector: string) => children[selector] ?? null,
  } as unknown as HTMLElement;
}

function doc(map: Record<string, unknown>): Document {
  return {
    querySelector: (selector: string) => map[selector] ?? null,
  } as unknown as Document;
}

describe('resolveSidebarMount', () => {
  it('优先用最内层的 #secondary-inner', () => {
    const inner = el();
    const secondary = el();
    const watch = el();
    const mount = resolveSidebarMount(
      doc({ 'ytd-watch-flexy': watch, '#secondary-inner': inner, '#secondary': secondary }),
    );
    expect(mount).toBe(inner);
  });

  it('没有 #secondary-inner 时退回 #secondary', () => {
    const secondary = el();
    const watch = el();
    const mount = resolveSidebarMount(doc({ 'ytd-watch-flexy': watch, '#secondary': secondary }));
    expect(mount).toBe(secondary);
  });

  it('不在观看页（没有 ytd-watch-flexy）时返回 null', () => {
    // 首页/搜索页也可能碰巧有 #secondary，但不能往那里插卡片
    expect(resolveSidebarMount(doc({ '#secondary': el() }))).toBeNull();
  });

  it('观看页但右栏还没渲染时返回 null', () => {
    expect(resolveSidebarMount(doc({ 'ytd-watch-flexy': el() }))).toBeNull();
  });

  it('宿主 id 固定，便于重挂与排查', () => {
    expect(SIDEBAR_HOST_ID).toBe('ytt-sidebar-host');
  });
});
