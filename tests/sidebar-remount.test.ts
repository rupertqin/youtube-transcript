import { describe, expect, it, vi } from 'vitest';
import { duplicateHosts, panelNeedsRemount } from '../src/ui/sidebar';

/**
 * 右栏宿主/面板的重挂判定。
 *
 * YouTube 重建 `#secondary-inner` 时会把我们的宿主一起摘掉，然后我们新建一个
 * shadow root —— 但面板元素还留在旧的 root 里。只补挂宿主不挪面板，用户看到的
 * 就是一张空白卡片；而 old root 里的面板还在继续渲染，是另一个「看着像卡住了」
 * 的来源。这两个纯函数就是决定「要不要挪 / 要不要清」的地方。
 */
describe('panelNeedsRemount', () => {
  const root = { name: 'shadow-root' } as unknown as Node;

  it('面板不在当前 shadow root 里时必须挪回去（宿主被重建的情形）', () => {
    const oldRoot = { name: 'old-root' } as unknown as Node;
    expect(panelNeedsRemount({ parentNode: oldRoot } as unknown as Node, root)).toBe(true);
  });

  it('面板已经挂在当前 root 里就不重复 append', () => {
    expect(panelNeedsRemount({ parentNode: root } as unknown as Node, root)).toBe(false);
  });

  it('还没有宿主（root 不存在）时不动，等下一次挂载', () => {
    expect(panelNeedsRemount(null, null)).toBe(false);
    expect(panelNeedsRemount({ parentNode: null } as unknown as Node, null)).toBe(false);
  });
});

describe('duplicateHosts', () => {
  const keep = { id: 'ytt-sidebar-host', remove: vi.fn() };
  const extra1 = { id: 'ytt-sidebar-host', remove: vi.fn() };
  const extra2 = { id: 'ytt-sidebar-host', remove: vi.fn() };

  it('保留当前宿主，其余旧的都算多余', () => {
    const list = [extra1, keep, extra2] as unknown as Element[];
    expect(duplicateHosts(list, keep as unknown as Element)).toEqual([extra1, extra2]);
  });

  it('只有自己一个宿主时不多余', () => {
    expect(duplicateHosts([keep] as unknown as Element[], keep as unknown as Element)).toEqual([]);
  });

  it('还没有宿主时不做任何清理', () => {
    const list = [extra1] as unknown as Element[];
    expect(duplicateHosts(list, null)).toEqual([extra1]);
  });
});
