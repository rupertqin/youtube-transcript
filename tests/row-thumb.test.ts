import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 章节行加了缩略图后，`applyRowState` 不能再靠 children 下标找元素 ——
 * 多一个截图节点后面全错位。这里用一个带 querySelector 的假 DOM 守住。
 */

interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  title: string;
  dataset: Record<string, string>;
  style: { setProperty(k: string, v: string): void } & Record<string, unknown>;
  children: FakeEl[];
  classList: { toggle(): void; add(): void };
  setAttribute(): void;
  append(child: FakeEl | { text: string }): void;
  appendChild(child: FakeEl | { text: string }): void;
  addEventListener(): void;
  querySelector(selector: string): FakeEl | null;
  querySelectorAll(): never[];
}

function makeEl(tagName = 'div'): FakeEl {
  const el: FakeEl = {
    tagName: tagName.toUpperCase(),
    className: '',
    textContent: '',
    title: '',
    dataset: {},
    style: {
      setProperty: (k: string, v: string) => {
        el.style[k] = v;
      },
    },
    children: [],
    classList: { toggle: () => undefined, add: () => undefined },
    setAttribute: () => undefined,
    append: (child) => {
      el.children.push(child as FakeEl);
    },
    appendChild: (child) => {
      el.children.push(child as FakeEl);
    },
    addEventListener: () => undefined,
    // 只支持本测试用到的 [data-role="x"] 形式。
    // 必须**递归**：时间戳现在内联在正文里，是 text 的子节点，不是 row 的直接子节点。
    querySelector: (selector: string) => {
      const match = /\[data-role="([^"]+)"\]/u.exec(selector);
      if (!match) return null;
      const want = match[1];
      const walk = (node: FakeEl): FakeEl | null => {
        for (const child of node.children ?? []) {
          if (child.dataset?.role === want) return child;
          const hit = walk(child);
          if (hit) return hit;
        }
        return null;
      };
      return walk(el);
    },
    querySelectorAll: () => {
      throw new Error('not supported');
    },
  };
  return el;
}

beforeEach(() => {
  vi.stubGlobal('document', {
    createElement: (tag: string) => makeEl(tag),
    createDocumentFragment: () => ({ append: () => undefined }),
    createTextNode: (text: string) => ({ text }),
  });
});

const frame = {
  url: 'https://i.ytimg.com/sb/x/storyboard3_L1/M0.jpg',
  offsetX: -112,
  offsetY: -63,
  sheetWidth: 560,
  sheetHeight: 315,
  width: 56,
  height: 31.5,
};

describe('章节行缩略图', () => {
  it('传入 thumb 时渲染一个裁切好的背景层', async () => {
    const { createRow } = await import('../src/ui/row');
    const row = createRow({
      line: { start: 1_694_000, dur: 0, text: 'Chapter 2' },
      original: 2,
      active: false,
      showTimestamps: true,
      needle: '',
      thumb: frame,
      onSeek: () => undefined,
    }) as unknown as FakeEl;

    const thumb = row.children.find((child) => child.style['background-image']);
    expect(thumb).toBeTruthy();
    expect(thumb!.style['background-image']).toBe(`url("${frame.url}")`);
    expect(thumb!.style['background-size']).toBe('560px 315px');
    expect(thumb!.style['background-position']).toBe('-112px -63px');
    expect(thumb!.style['background-repeat']).toBe('no-repeat');
  });

  it('没传 thumb 时不多渲染节点', async () => {
    const { createRow } = await import('../src/ui/row');
    const row = createRow({
      line: { start: 1000, dur: 0, text: 'line' },
      original: 0,
      active: false,
      showTimestamps: true,
      needle: '',
      thumb: null,
      onSeek: () => undefined,
    }) as unknown as FakeEl;

    expect(row.children.some((child) => child.style['background-image'])).toBe(false);
  });

  it('有缩略图时 applyRowState 仍能正确更新播放条/时间/正文', async () => {
    const { applyRowState, createRow } = await import('../src/ui/row');
    const row = createRow({
      line: { start: 1_694_000, dur: 0, text: 'Chapter 2' },
      original: 2,
      active: false,
      showTimestamps: true,
      needle: '',
      thumb: frame,
      onSeek: () => undefined,
    }) as unknown as FakeEl;

    applyRowState(row as unknown as HTMLElement, true, true);

    const text = row.querySelector('[data-role="text"]')!;
    const time = row.querySelector('[data-role="time"]')!;
    const bar = row.querySelector('[data-role="bar"]')!;

    // 三处都要变，不能因为多了缩略图就错位。
    // 时间戳内联在正文开头、保持灰色；高亮靠正文变亮 + 左侧竖条。
    expect(text.className).toContain('text-[var(--ytt-transcript)]');
    expect(time.className).toContain('text-[var(--ytt-text-dim)]');
    // 内联而不是独立一行：设了 block 就又会跑到正文上方
    expect(time.className).not.toContain('block');
    expect(time.textContent).toBe('(28:14)');
    expect(bar.className).toContain('bg-[var(--ytt-accent)]');
  });
});
