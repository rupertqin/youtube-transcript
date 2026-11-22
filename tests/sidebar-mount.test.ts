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

  it('B 站普通 UP 主视频页：用 .right-container-inner', () => {
    const inner = el();
    const right = el({ '.right-container-inner': inner });
    const vdcon = el({ '.right-container': right });
    expect(resolveSidebarMount(doc({ '#mirror-vdcon': vdcon }))).toBe(inner);
  });

  it('B 站右栏晚到时仍能被识别', () => {
    const right = el();
    // #mirror-vdcon 还没渲染，但 .video-container-v1 .right-container 已在页面上
    expect(resolveSidebarMount(doc({ '.video-container-v1 .right-container': right }))).toBe(right);
  });

  it('B 站没有右栏的布局返回 null（由适配器退回浮层）', () => {
    expect(resolveSidebarMount(doc({ '#mirror-vdcon': el() }))).toBeNull();
  });

  it('宿主 id 固定，便于重挂与排查', () => {
    expect(SIDEBAR_HOST_ID).toBe('ytt-sidebar-host');
  });
});
