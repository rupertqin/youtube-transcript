import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptLine } from '../src/core/types';

/**
 * 用户报的「点击时间点有问题」：row.ts 把毫秒的 line.start 直接交给
 * 按「秒」设计的 seek()，1:05 会跳到 65000 秒。
 * 这里用极小的假 DOM 真跑一次点击，守住单位换算。
 */

interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  title: string;
  dataset: Record<string, string>;
  style: { setProperty(): void; display: string };
  children: FakeEl[];
  listeners: Record<string, ((event?: unknown) => void)[]>;
  classList: { toggle(): void; add(): void };
  setAttribute(name: string, value: string): void;
  append(child: FakeEl | { text: string }): void;
  appendChild(child: FakeEl | { text: string }): void;
  addEventListener(type: string, fn: (event?: unknown) => void): void;
  click(): void;
  replaceChildren(): void;
}

function makeEl(tagName: string): FakeEl {
  const el: FakeEl = {
    tagName: tagName.toUpperCase(),
    className: '',
    textContent: '',
    title: '',
    dataset: {},
    style: { setProperty: () => undefined, display: '' },
    children: [],
    listeners: {},
    classList: { toggle: () => undefined, add: () => undefined },
    setAttribute: () => undefined,
    append: (child) => {
      el.children.push(child as FakeEl);
    },
    appendChild: (child) => {
      el.children.push(child as FakeEl);
    },
    addEventListener: (type, fn) => {
      (el.listeners[type] ??= []).push(fn);
    },
    click: () => {
      for (const fn of el.listeners.click ?? []) fn({});
    },
    replaceChildren: () => undefined,
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

describe('点击时间点 seek 单位', () => {
  it('毫秒起点换算成秒再交给 seek', async () => {
    const { createRow } = await import('../src/ui/row');
    const line: TranscriptLine = { start: 65_000, dur: 0, text: 'third line' };
    const onSeek = vi.fn();

    const row = createRow({
      line,
      original: 2,
      active: false,
      showTimestamps: true,
      needle: '',
      onSeek,
    }) as unknown as FakeEl;

    row.click();

    // 修复前这里是 65000（跳到 18 小时处），正确值是 65 秒
    expect(onSeek).toHaveBeenCalledWith(65);
    expect(onSeek).not.toHaveBeenCalledWith(65_000);
  });

  it('没有时间码的行不触发 seek', async () => {
    const { createRow } = await import('../src/ui/row');
    const onSeek = vi.fn();
    const row = createRow({
      line: { start: -1, dur: 0, text: 'no timestamp' },
      original: 0,
      active: false,
      showTimestamps: false,
      needle: '',
      onSeek,
    }) as unknown as FakeEl;

    row.click();
    expect(onSeek).not.toHaveBeenCalled();
  });
});
