import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 用户报的「时间戳开关不是立即反应到 UI 上」：
 * 开关只改变行结构、不改变行数，而 setCount 在数量相同时直接 return，
 * 导致已挂载的行永远不会重建。refresh() 必须能把它们重建掉。
 */

interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  style: { setProperty(k: string, v: string): void } & Record<string, unknown>;
  dataset: Record<string, string>;
  children: FakeEl[];
  scrollTop: number;
  clientHeight: number;
  clientWidth: number;
  offsetHeight: number;
  classList: { toggle(): void; add(): void };
  setAttribute(): void;
  appendChild(child: FakeEl): void;
  append(child: FakeEl): void;
  remove(): void;
  addEventListener(): void;
  removeEventListener(): void;
  scrollTo(options: { top: number; behavior?: string }): void;
}

function makeEl(tag = 'div'): FakeEl {
  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    style: { setProperty: () => undefined },
    dataset: {},
    children: [],
    scrollTop: 0,
    clientHeight: 600,
    clientWidth: 380,
    offsetHeight: 40,
    classList: { toggle: () => undefined, add: () => undefined },
    setAttribute: () => undefined,
    appendChild: (child) => {
      el.children.push(child);
    },
    append: (child) => {
      el.children.push(child);
    },
    remove: () => {
      // 从父节点摘掉即可
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    scrollTo: ({ top }: { top: number }) => {
      el.scrollTop = top;
    },
  };
  return el;
}

beforeEach(() => {
  vi.stubGlobal('document', { createElement: (tag: string) => makeEl(tag) });
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => {
    fn();
    return 0;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

describe('虚拟列表 refresh', () => {
  it('行数不变时 refresh 会重新渲染行', async () => {
    const { createVirtualList } = await import('../src/ui/virtual-list');
    const renderRow = vi.fn(() => makeEl('button') as unknown as HTMLElement);

    const list = createVirtualList({ renderRow });
    list.setCount(5);
    const afterFirst = renderRow.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    // 模拟「开关时间戳」：行数不变，但每行结构变了
    list.refresh();
    expect(renderRow.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it('refresh 保留滚动位置（开关时间戳不该把列表弹回顶部）', async () => {
    const { createVirtualList } = await import('../src/ui/virtual-list');
    const list = createVirtualList({ renderRow: () => makeEl('button') as unknown as HTMLElement });

    list.setCount(200);
    list.element.scrollTop = 2500;
    list.refresh();
    expect(list.element.scrollTop).toBe(2500);
  });

  it('setCount 行数不变时本身不重建（正是原 bug 的成因）', async () => {
    const { createVirtualList } = await import('../src/ui/virtual-list');
    const renderRow = vi.fn(() => makeEl('button') as unknown as HTMLElement);

    const list = createVirtualList({ renderRow });
    list.setCount(5);
    const before = renderRow.mock.calls.length;
    list.setCount(5);
    expect(renderRow.mock.calls.length).toBe(before);
  });
});
