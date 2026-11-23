import { describe, expect, it, vi } from 'vitest';
import { readDomPreview, readRenderedTranscript } from '../src/core/dom/native-panel';
import { contentSignature } from '../src/core/format/fingerprint';

/**
 * 真实缺陷：虚拟列表只渲染视口附近的行，同步读一次常常只剩播放位置那一段
 * —— 实际只读到 1:58 之后的 43 行，前面整段都漏了，而原生面板滚下来是全的。
 *
 * 这里测的是「在面板自己的滚动容器里从头滚到底，把每一屏的行按时间码并起来」。
 */

const holder = vi.hoisted(() => ({ panelRoot: null as unknown }));
vi.mock('../src/core/dom/panel', () => ({ pickPanel: () => holder.panelRoot }));

const ALL = Array.from({ length: 30 }, (_, i) => ({ start: i * 3_000, text: `row ${i}` }));
const ROW_H = 20;
const WINDOW_ROWS = 10;

/** 按 scrollTop 只渲染一个窗口，模拟虚拟列表 */
function makeDom() {
  let top = 0;
  const scroller = {
    scrollHeight: ALL.length * ROW_H,
    clientHeight: WINDOW_ROWS * ROW_H,
    querySelectorAll: () => [],
    get scrollTop() {
      return top;
    },
    set scrollTop(value: number) {
      const max = ALL.length * ROW_H - WINDOW_ROWS * ROW_H;
      top = Math.max(0, Math.min(value, max));
    },
  };
  const panelRoot = { querySelectorAll: () => [scroller], parentElement: null };
  const renderWindow = (): string =>
    ALL.slice(Math.round(top / ROW_H), Math.round(top / ROW_H) + WINDOW_ROWS)
      .map((row) => `${Math.floor(row.start / 60_000)}:${String(Math.floor((row.start % 60_000) / 1_000)).padStart(2, '0')} ${row.text}`)
      .join('\n');
  const doc = {
    body: {
      get innerText() {
        return renderWindow();
      },
    },
  } as unknown as Document;
  return { doc, panelRoot, scroller };
}

const { doc, panelRoot, scroller } = makeDom();
holder.panelRoot = panelRoot;

describe('readRenderedTranscript：滚动读全，不再漏前段', () => {
  it('一次同步读只有视口那一段，滚到底后能攒齐全部行', async () => {
    const result = await readRenderedTranscript(doc);

    // 30 行全都要拿到，尤其是最前面那些
    expect(result.lines).toHaveLength(ALL.length);
    expect(result.lines[0].text).toBe('row 0');
    expect(result.lines[result.lines.length - 1].text).toBe('row 29');
    // 时间码去重：没有重复行
    const starts = result.lines.map((line) => line.start);
    expect(new Set(starts).size).toBe(starts.length);
  });

  it('滚完会把 scrollTop 还原，不打扰用户正在看的位置', async () => {
    scroller.scrollTop = 4 * ROW_H;
    const before = scroller.scrollTop;

    await readRenderedTranscript(doc);

    expect(scroller.scrollTop).toBe(before);
  });
});

describe('skipSnapshot 与内容指纹闸门', () => {
  it('skipSnapshot 时一条都不读（换台首抓宁可判失败，交给自动重试）', async () => {
    const skipped = await readRenderedTranscript(doc, { skipSnapshot: true });
    expect(skipped.lines).toHaveLength(0);

    // 去掉这个开关（重试那一轮 switchPending 已消费）才读页面上的内容
    const allowed = await readRenderedTranscript(doc, { avoidSignature: null });
    expect(allowed.lines.length).toBeGreaterThan(0);
  });

  it('指纹闸门只覆盖「可见窗口」，挡不住整条字幕的指纹', () => {
    const window = readDomPreview(doc);
    expect(window.lines.length).toBeGreaterThan(0);

    // 同一批行：挡得住
    const blocked = readDomPreview(doc, { avoidSignature: contentSignature(window.lines) });
    expect(blocked.lines).toHaveLength(0);

    // 但 session 存的是「整条字幕」的指纹，虚拟列表里窗口只是其中一段 → 挡不住。
    // 这就是换台首抓不能放开 DOM 兜底的原因。
    const whole = contentSignature(
      ALL.map((row) => ({ start: row.start, dur: 0, text: row.text })),
    );
    const leaked = readDomPreview(doc, { avoidSignature: whole });
    expect(leaked.lines.length).toBeGreaterThan(0);
  });
});
