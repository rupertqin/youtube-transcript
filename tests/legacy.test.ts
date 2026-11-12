import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractTranscriptLegacy } from '../src/core/dom/legacy';
import { createLegacyRuntime } from '../src/core/dom/legacy-runtime';
import type { LegacyV19 } from '../src/legacy/contract';

beforeAll(() => {
  // 原版 isVisible() 用 getComputedStyle；node 环境里打个桩即可
  vi.stubGlobal('getComputedStyle', () => ({ display: 'block', visibility: 'visible' }));
});

interface FakeOptions {
  innerText?: string;
  query?: (selector: string) => unknown;
  queryAll?: (selector: string) => unknown[];
}

function fakeEl(options: FakeOptions = {}): HTMLElement {
  const text = options.innerText ?? '';
  return {
    innerText: text,
    textContent: text,
    getAttribute: () => '',
    tagName: 'DIV',
    children: [],
    getClientRects: () => [{ width: 1 }],
    querySelector: (sel: string) => (options.query?.(sel) ?? null) as Element | null,
    querySelectorAll: (sel: string) => (options.queryAll?.(sel) ?? []) as unknown as NodeListOf<Element>,
    click: () => undefined,
  } as unknown as HTMLElement;
}

const TRANSCRIPT_TEXT = '13:48 first line\n13:59 second line\n14:09 third line';

/** 复刻原版 extractFallback 的切分逻辑，作为 v19 运行时的测试替身。 */
function originalFallback(panel: Element): { text: string } {
  const raw = ((panel as HTMLElement | null)?.innerText || '')
    .split('\n')
    .map((line) => line.replace(/\s+/gu, ' ').trim())
    .filter(Boolean)
    .join('\n');
  if (!raw) return { text: '' };
  const parts = raw.split(/\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*/u);
  const out: string[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const time = parts[i];
    const body = (parts[i + 1] ?? '').replace(/\s+/gu, ' ').trim();
    if (time && body) out.push(`${time} ${body}`);
  }
  return { text: out.length ? out.join('\n') : raw };
}

function stubV19(): void {
  vi.stubGlobal('__yttLegacyV19', {
    extractFallback: originalFallback,
    openTranscriptPanel: async () => null,
    extractTranscript: async () => ({ text: '', showTimestamps: false }),
  } as unknown as LegacyV19);
}

function docWithTimecodeContainer(): Document {
  const list = fakeEl({ innerText: TRANSCRIPT_TEXT });
  return {
    querySelector: () => null,
    querySelectorAll: (sel: string) => (sel === '*' ? [list] : []),
    body: fakeEl({ innerText: '' }),
  } as unknown as Document;
}

describe('第 1 步：原版整份内联，只多一行导出', () => {
  it('verbatim.js 与 user-script.js 逐字节一致', () => {
    const a = readFileSync(new URL('../user-script.js', import.meta.url));
    const b = readFileSync(new URL('../src/legacy/verbatim.js', import.meta.url));
    expect(a.equals(b)).toBe(true);
  });

  it('导出名单里的每个名字都在原版作用域里声明过（防止 IIFE 抛 ReferenceError）', () => {
    const original = readFileSync(new URL('../user-script.js', import.meta.url), 'utf8');
    const runtime = readFileSync(new URL('../src/legacy/verbatim-runtime.js', import.meta.url), 'utf8');
    const block = runtime.slice(runtime.indexOf('// [ytt] 唯一新增'));
    const csv = /\{([\s\S]*?)\}/u.exec(block)?.[1] ?? '';
    const names = [...new Set(csv.match(/\b\w+\b/gu) ?? [])];
    const declared = new Set([...original.matchAll(/(?:function|const|let|var)\s+(\w+)/gu)].map((m) => m[1]));
    expect(names.length).toBeGreaterThanOrEqual(15);
    for (const name of names) expect(declared.has(name)).toBe(true);
  });

  it('verbatim-runtime.js 除去导出行后与原版逐字节一致', () => {
    const original = readFileSync(new URL('../user-script.js', import.meta.url), 'utf8');
    const runtime = readFileSync(new URL('../src/legacy/verbatim-runtime.js', import.meta.url), 'utf8');
    const exportBlock = /\n    \/\/ \[ytt\] 唯一新增[\s\S]*?\n    \};\n/u;
    expect(exportBlock.test(runtime)).toBe(true);
    expect(runtime.replace(exportBlock, '')).toBe(original);
    expect(runtime).toContain('addCopyButton');
  });
});

describe('第 2 步：新版 dom 层直接调用原版函数', () => {
  it('原版 extractFallback 喂给含时间码的候选 → 3 行结构化字幕', async () => {
    stubV19();
    const result = await extractTranscriptLegacy(docWithTimecodeContainer());
    expect(result.lines).toHaveLength(3);
    expect(result.lines[0]).toEqual({ start: 828000, dur: 0, text: 'first line' });
    expect(result.lines[2]).toEqual({ start: 849000, dur: 0, text: 'third line' });
  });

  it('原版运行时没加载时返回空且不抛错', async () => {
    vi.stubGlobal('__yttLegacyV19', undefined);
    const result = await extractTranscriptLegacy(docWithTimecodeContainer());
    expect(result.lines).toEqual([]);
  });
});

describe('移植版运行时（留作对照，下一步才删）', () => {
  function docWithTranscriptPanel(): Document {
    const list = fakeEl({ innerText: TRANSCRIPT_TEXT });
    const panel = fakeEl({
      query: (sel) => (sel.includes('segment-list-renderer') ? list : null),
      queryAll: (sel) => (sel.includes('segment-list-renderer') ? [list] : []),
    });
    return {
      querySelector: () => null,
      querySelectorAll: (sel: string) =>
        sel.includes('transcript-search-panel-renderer') || sel.includes('engagement-panel-transcript') || sel.includes('role="dialog"')
          ? [panel]
          : [],
    } as unknown as Document;
  }

  it('没有片段标签时，extractFallback 按时间码切出字幕', async () => {
    const result = await createLegacyRuntime(docWithTranscriptPanel()).run();
    expect(result.lines).toBe(3);
    expect(result.text.split('\n')).toEqual([
      '13:48 first line',
      '13:59 second line',
      '14:09 third line',
    ]);
  });

  it('面板内文本没有时间码时，原样按行输出', () => {
    const panel = fakeEl({ innerText: '  Transcript  \n\n Chapters  \n  Key moments ', query: () => null });
    expect(createLegacyRuntime({} as Document).extractFallback(panel).text).toBe(
      'Transcript\nChapters\nKey moments',
    );
  });

  it('collapseDuplicates 保留原版的连续去重与整段减半', () => {
    const { collapseDuplicates } = createLegacyRuntime({} as Document);
    expect(collapseDuplicates(['a', 'a', 'b'], true)).toEqual(['a', 'b']);
    expect(collapseDuplicates(['a', 'b', 'a', 'b'], false)).toEqual(['a', 'b']);
  });
});

describe('原版被 if (!panel) return 挡住的那一套：整页文本按时间码切分', () => {
  function docWithBody(innerText: string): Document {
    return {
      body: fakeEl({ innerText }),
      querySelector: () => null,
      querySelectorAll: () => [],
    } as unknown as Document;
  }

  it('面板找不到时，整页文本仍能经原版 extractFallback 切出字幕，并挡掉乱序时长', async () => {
    stubV19();
    const result = await extractTranscriptLegacy(
      docWithBody(
        '推荐视频 30:24\nTranscript\n13:48 first line\n13:59 second line\n14:09 third line\n6:44 另一个视频',
      ),
    );
    expect(result.lines).toHaveLength(3);
    expect(result.lines[0]).toEqual({ start: 828000, dur: 0, text: 'first line' });
    expect(result.lines[2]).toEqual({ start: 849000, dur: 0, text: 'third line' });
    expect(result.showTimestamps).toBe(true);
  });

  it('只有乱序的推荐列表时长，不产生假字幕', async () => {
    stubV19();
    const result = await extractTranscriptLegacy(docWithBody('A 30:24\nB 6:44\nC 1:03:07'));
    expect(result.lines).toEqual([]);
  });

  it('诊断里写明整页文本与递增段的实况', async () => {
    stubV19();
    await extractTranscriptLegacy(docWithBody('13:48 first\n13:59 second\n14:09 third'));
    const diagnostic = (await import('../src/core/dom/legacy')).getLegacyDiagnostic();
    expect(diagnostic).toContain('快照');
    expect(diagnostic).toContain('最长递增段');
    expect(diagnostic).toContain('采用当前 DOM 快照');
  });
});

describe('按钮的职责是复制已有文字，不是去开面板', () => {
  it('快照读到字幕时，绝不调用 openTranscriptPanel（避免把已开面板点关）', async () => {
    const openPanel = vi.fn(async () => null);
    vi.stubGlobal('__yttLegacyV19', {
      extractFallback: originalFallback,
      openTranscriptPanel: openPanel,
      extractTranscript: async () => ({ text: '', showTimestamps: false }),
    } as unknown as LegacyV19);

    const result = await extractTranscriptLegacy({
      body: fakeEl({ innerText: '13:48 first\n13:59 second\n14:09 third' }),
      querySelector: () => null,
      querySelectorAll: () => [],
    } as unknown as Document);

    expect(result.lines).toHaveLength(3);
    expect(openPanel).not.toHaveBeenCalled();
  });

  it('面板已展开时不再跳过原版 openTranscriptPanel（修复后它自己能认出 2026 面板）', async () => {
    const openPanel = vi.fn(async () => null);
    vi.stubGlobal('__yttLegacyV19', {
      extractFallback: originalFallback,
      openTranscriptPanel: openPanel,
      extractTranscript: async () => ({ text: '', showTimestamps: false }),
    } as unknown as LegacyV19);

    const closeBtn = {
      ...fakeEl({ innerText: '' }),
      getAttribute: (name: string) => (name === 'aria-label' ? 'Close transcript' : ''),
      getClientRects: () => [{ width: 1 }],
    };
    const doc = {
      body: fakeEl({ innerText: 'no transcript here' }),
      querySelector: () => null,
      querySelectorAll: (sel: string) =>
        sel === '*' || sel.includes('button') ? [closeBtn] : [],
    } as unknown as Document;

    await extractTranscriptLegacy(doc);
    expect(openPanel).toHaveBeenCalledTimes(1);
    const diagnostic = (await import('../src/core/dom/legacy')).getLegacyDiagnostic();
    expect(diagnostic).toContain('面板已展开');
    expect(diagnostic).toContain('走原版 openTranscriptPanel');
  }, 10_000);
});
