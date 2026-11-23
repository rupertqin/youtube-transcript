import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptLine } from '../src/core/types';

/**
 * 阅读排版这一层的护栏：
 *   ① 字幕没有段落信息，段首只能靠标点/停顿推断 —— 推错就是留白多一行
 *   ② 中文行等宽 / 英文行小一号，激活行**不能**改字重（会重排、行高错）
 *   ③ 字号行高全部走 CSS 变量，切档不重建节点
 *   ④ 拖选正文时点击不该跳转
 */

const line = (text: string, start: number, dur = 0): TranscriptLine => ({ text, start, dur });

describe('paragraphStarts：字幕的段落是推断出来的', () => {
  it('第一条永远不算段首（列表顶上不需要留白）', async () => {
    const { paragraphStarts } = await import('../src/ui/panel');
    expect(paragraphStarts([line('开场。', 0, 2000)])).toEqual([false]);
  });

  it('上一条以句号收尾 → 下一行是段首', async () => {
    const { paragraphStarts } = await import('../src/ui/panel');
    expect(paragraphStarts([line('第一句。', 0, 2000), line('第二句', 2000, 2000)])).toEqual([
      false,
      true,
    ]);
  });

  it('中英文句末标点都算，收尾引号不影响', async () => {
    const { paragraphStarts } = await import('../src/ui/panel');
    const flags = paragraphStarts([
      line('他说：“走吧。”', 0, 1000),
      line('English ends here.', 1000, 1000),
      line('next', 2000, 1000),
    ]);
    expect(flags).toEqual([false, true, true]);
  });

  it('话还没说完（无标点、无停顿）就不是段首', async () => {
    const { paragraphStarts } = await import('../src/ui/panel');
    expect(paragraphStarts([line('这一句还没', 0, 2000), line('说完就断了', 2000, 2000)])).toEqual([
      false,
      false,
    ]);
  });

  it('静默超过 1.2s 也算换段；dur=0 时不能靠时间猜', async () => {
    const { paragraphStarts } = await import('../src/ui/panel');
    expect(paragraphStarts([line('停顿之后', 0, 1000), line('又开口', 3000, 1000)])).toEqual([
      false,
      true,
    ]);
    // dur 未知时 start 之间的差没有意义，不能误判成段首
    expect(paragraphStarts([line('停顿之后', 0, 0), line('又开口', 30_000, 0)])).toEqual([
      false,
      false,
    ]);
  });
});

interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  dataset: Record<string, string>;
  style: Record<string, unknown> & { setProperty(k: string, v: string): void };
  children: FakeEl[];
  listeners: Record<string, (event?: unknown) => void>;
  attrs: Record<string, string>;
  append(child: unknown): void;
  appendChild(child: unknown): void;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, fn: (event?: unknown) => void): void;
}

function makeEl(tag = 'div'): FakeEl {
  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    dataset: {},
    style: {
      setProperty: (k: string, v: string) => {
        el.style[k] = v;
      },
    },
    children: [],
    listeners: {},
    attrs: {},
    append: (child) => {
      el.children.push(child as FakeEl);
    },
    appendChild: (child) => {
      el.children.push(child as FakeEl);
    },
    setAttribute: (name, value) => {
      el.attrs[name] = value;
    },
    addEventListener: (type, fn) => {
      el.listeners[type] = fn;
    },
  };
  return el;
}

const fakeDocument = (): unknown => ({
  createElement: (tag: string) => makeEl(tag),
  createDocumentFragment: () => {
    const fragment = makeEl('#fragment');
    return fragment;
  },
  createTextNode: (text: string) => ({ textContent: text, dataset: {}, children: [] }),
});

interface RowOptionsLike {
  line: TranscriptLine;
  original: number;
  active: boolean;
  showTimestamps: boolean;
  needle: string;
  paraStart?: boolean;
  onSeek: (seconds: number) => void;
}

describe('行排版：语言分档、段首留白、字重稳定', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('document', fakeDocument());
  });

  const build = async (patch: Partial<RowOptionsLike> = {}): Promise<FakeEl> => {
    const { createRow } = await import('../src/ui/row');
    const options: RowOptionsLike = {
      line: line('中文的一行', 1000, 0),
      original: 0,
      active: false,
      showTimestamps: true,
      needle: '',
      onSeek: () => undefined,
      ...patch,
    };
    return createRow(options as never) as unknown as FakeEl;
  };

  const textOf = (row: FakeEl): FakeEl =>
    row.children.find((child) => child.dataset?.role === 'text') as FakeEl;

  it('中文行用等宽类，英文行用英文类（字号由 CSS 变量给，不在标签上写死）', async () => {
    const cn = textOf(await build());
    expect(cn.className).toContain('ytt-line-cn');
    expect(cn.className).not.toContain('text-[14px]');

    const en = textOf(await build({ line: line('pure english line', 0, 0) }));
    expect(en.className).toContain('ytt-line-en');
    expect(en.className).not.toContain('text-[12px]');
  });

  it('行不设宽度上限，竖条贴着正文（留白 16px、条占 4-7px）', async () => {
    const row = await build();
    expect(row.className).not.toContain('max-w-');
    expect(row.className).toContain('px-4');
    const bar = row.children.find((child) => child.dataset?.role === 'bar') as FakeEl;
    expect(bar.className).toContain('left-1');
  });

  it('段首行多一段留白，普通行不加', async () => {
    const plain = await build();
    expect(plain.className).not.toContain('ytt-row-para');

    const para = await build({ paraStart: true });
    expect(para.className).toContain('ytt-row-para');
  });

  it('激活行不改字重；字色走主题令牌（深色靠明暗、浅色同色）', async () => {
    const active = textOf(await build({ active: true }));
    const idle = textOf(await build({ active: false }));
    expect(active.className).not.toContain('font-medium');
    expect(active.className).toContain('text-[var(--ytt-transcript)]');
    // 非激活行用 idle 令牌：深色主题下它是灰的，浅色主题下被覆盖成同一个黑
    expect(idle.className).toContain('text-[var(--ytt-transcript-idle)]');
  });

  it('拖选正文时点击不跳转，没选区才 seek', async () => {
    const onSeek = vi.fn();
    const row = await build({ onSeek });

    // 没有选区（node 环境没有 window）→ 正常跳
    row.listeners.click?.({});
    expect(onSeek).toHaveBeenCalledWith(1);

    // 有选区 → 用户是在选文字，不该把他带走
    onSeek.mockClear();
    vi.stubGlobal('window', {
      getSelection: () => ({ isCollapsed: false, toString: () => '选中了这句' }),
    });
    row.listeners.click?.({});
    expect(onSeek).not.toHaveBeenCalled();
  });
});

describe('虚拟列表：跟随播放只在行离开视口时滚', () => {
  interface ScrollEl extends FakeEl {
    scrollTop: number;
    clientHeight: number;
    clientWidth: number;
    offsetHeight: number;
    scrolls: { top: number; behavior?: string }[];
    scrollTo(options: { top: number; behavior?: string }): void;
    removeEventListener(): void;
  }

  const makeScrollEl = (tag = 'div'): ScrollEl => {
    const el = makeEl(tag) as ScrollEl;
    el.scrollTop = 0;
    el.clientHeight = 600;
    el.clientWidth = 380;
    el.offsetHeight = 40;
    el.scrolls = [];
    el.scrollTo = (options) => {
      el.scrolls.push(options);
      el.scrollTop = options.top;
    };
    el.removeEventListener = () => undefined;
    return el;
  };

  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('document', { createElement: (tag: string) => makeScrollEl(tag) });
    vi.stubGlobal('requestAnimationFrame', (fn: () => void) => {
      fn();
      return 0;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
  });

  it('完整落在视口里的行算可见，滚走的行不算', async () => {
    const { createVirtualList } = await import('../src/ui/virtual-list');
    const list = createVirtualList({ renderRow: () => makeScrollEl('button') as unknown as HTMLElement });
    list.setCount(10);

    expect(list.isVisible(0)).toBe(true);
    expect(list.isVisible(9)).toBe(true);

    list.scrollToIndex(9, 'start');
    expect(list.isVisible(9)).toBe(true);
    expect(list.isVisible(0)).toBe(false);
  });

  it('系统要求减少动态效果时不做平滑滚动', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const { createVirtualList } = await import('../src/ui/virtual-list');
    const list = createVirtualList({ renderRow: () => makeScrollEl('button') as unknown as HTMLElement });
    list.setCount(10);

    list.scrollToIndex(9, 'start');
    const last = (list.element as unknown as ScrollEl).scrolls.at(-1);
    expect(last?.behavior).toBe('auto');
  });
});

describe('styles.css：排版令牌是唯一出处', () => {
  const css = readFileSync(new URL('../src/ui/styles.css', import.meta.url), 'utf8');

  it('字号 / 行高 / 字体栈都是变量', () => {
    for (const token of ['--ytt-fs-body', '--ytt-lh-ratio', '--ytt-font-ui', '--ytt-font-cn']) {
      expect(css).toContain(token);
    }
  });

  it('正文不设行宽上限（面板多宽就用多宽）', () => {
    expect(css).not.toContain('--ytt-measure');
  });

  it('中英文同字号，靠字距与行距区分（字号跳变会让人以为两段是不同层级）', () => {
    const cnStack = /--ytt-font-cn:([\s\S]*?);/.exec(css)?.[1] ?? '';
    expect(cnStack).toMatch(/PingFang SC/);
    // 同字号：英文的号直接引用正文号
    expect(css).toMatch(/--ytt-fs-en:\s*var\(--ytt-fs-body\)/);
    // 中文行放宽字距 + 用中文行高
    expect(css).toMatch(/\.ytt-line-cn\s*\{[^}]*letter-spacing:\s*0?\.\d+em/);
    expect(css).toMatch(/\.ytt-line-cn\s*\{[^}]*line-height:\s*var\(--ytt-lh\)/);
    // 英文行拉到正常字距、行高收紧
    expect(css).toMatch(/\.ytt-line-en\s*\{[^}]*letter-spacing:\s*normal/);
    expect(css).toMatch(/\.ytt-line-en\s*\{[^}]*line-height:\s*var\(--ytt-lh-en\)/);
    // 时间戳跟着父行走，否则会把英文行的紧行距撑回去
    expect(css).toMatch(/\.ytt-line-time\s*\{[^}]*line-height:\s*inherit/);
  });

  it('字幕正文颜色是独立令牌：深色保持原样，浅色主题覆盖成 #0f0f0f', () => {
    // 深色（默认）：激活亮、非激活灰
    expect(css).toMatch(/--ytt-transcript:\s*#f1f1f1/);
    expect(css).toMatch(/--ytt-transcript-idle:\s*#aaaaaa/);
    // 浅色：两者都覆盖成纯黑
    const light = /\.ytt-root\.ytt-light\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(light).toMatch(/--ytt-transcript:\s*#0f0f0f/);
    expect(light).toMatch(/--ytt-transcript-idle:\s*#0f0f0f/);
  });

  it('三档字号、两档行距都有对应 class', () => {
    for (const cls of ['.ytt-fs-sm', '.ytt-fs-lg', '.ytt-lh-tight', '.ytt-lh-loose']) {
      expect(css).toContain(cls);
    }
  });

  it('中文行有避头尾与标点挤压，正文可选中，长词不撑破行', () => {
    expect(css).toContain('line-break: strict');
    expect(css).toContain('text-spacing-trim');
    expect(css).toContain('user-select: text');
    expect(css).toContain('overflow-wrap: anywhere');
  });

  it('搜索高亮是琥珀色且跨行克隆（不再和「正在播放」的红撞色）', () => {
    expect(css).toContain('mark.ytt-mark');
    expect(css).toContain('box-decoration-break: clone');
    expect(css).not.toContain('--ytt-highlight: rgba(255, 0, 0, 0.2)');
  });
});
