import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import type { TranscriptLine } from '../src/core/types';

/**
 * 两个入口（原版 Copy Transcript 按钮 / 新版面板）共用同一份复制实现。
 * 这里直接执行真实运行时里的共享函数，测的就是产物跑的那份代码。
 */
interface SharedApi {
  formatStamp(ms: number): string;
  stripA11yDuration(text: string): string;
  textToRows(text: string): TranscriptLine[];
  parseChapters(text: string): TranscriptLine[];
  readChapterRows(doc: unknown): TranscriptLine[];
  formatCopyText(rows: TranscriptLine[], options: Record<string, unknown>): string;
  sharedPrefs(): { timestamps: boolean; view: string };
  setSharedPrefs(patch: Record<string, unknown>): Record<string, unknown>;
}

function loadShared(): { api: SharedApi; sandbox: Record<string, unknown> } {
  const source = readFileSync(new URL('../src/legacy/verbatim-runtime.js', import.meta.url), 'utf8');
  const sandbox: Record<string, unknown> = {
    document: {
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: () => null,
      createElement: () => ({ style: {}, classList: { add: () => undefined } }),
    },
    navigator: { clipboard: { writeText: async () => undefined } },
    location: { href: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    console,
    alert: () => undefined,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    setInterval: () => 0,
    clearInterval: () => undefined,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  runInNewContext(source, sandbox);
  return { api: sandbox.__yttLegacyV19 as SharedApi, sandbox };
}

const rows = (): TranscriptLine[] => [
  { start: 0, dur: 0, text: 'hello there' },
  { start: 65_000, dur: 0, text: 'second line' },
];

describe('无障碍时长清洗（复制里 33:26 后面那串）', () => {
  const { api } = loadShared();

  it('删掉与时间码数值一致的复述', () => {
    expect(api.stripA11yDuration('33:26 33 minutes, 26 seconds')).toBe('33:26');
    expect(api.stripA11yDuration('33:26 33 minutes, 26 seconds 正文在这里')).toBe('33:26 正文在这里');
    expect(api.stripA11yDuration('1:01:01 1 hour, 1 minute, 1 second done')).toBe('1:01:01 done');
  });

  it('处理 YouTube 那种没有空格的粘连', () => {
    expect(api.stripA11yDuration("3:32 3 minutes, 32 secondsI don't know")).toBe("3:32 I don't know");
  });

  it('独占一行的复述也去掉', () => {
    expect(api.stripA11yDuration('0:05 正文\n5 seconds')).toBe('0:05 正文');
  });

  it('数值对不上的正常字幕不动', () => {
    // 这是真实台词，不是 0:83 的复述
    expect(api.stripA11yDuration('1:23 we waited 5 minutes for the build')).toBe(
      '1:23 we waited 5 minutes for the build',
    );
    expect(api.stripA11yDuration('10:00 only 2 seconds left')).toBe('10:00 only 2 seconds left');
  });
});

describe('复制文本格式化（两个入口共用）', () => {
  const { api } = loadShared();

  it('带时间戳', () => {
    expect(api.formatCopyText(rows(), { timestamps: true })).toBe('0:00 hello there\n1:05 second line');
  });

  it('不带时间戳', () => {
    expect(api.formatCopyText(rows(), { timestamps: false })).toBe('hello there\nsecond line');
  });

  it('复制时顺手清洗复述时长', () => {
    const dirty: TranscriptLine[] = [{ start: 2006_000, dur: 0, text: '33 minutes, 26 seconds 真实内容' }];
    expect(api.formatCopyText(dirty, { timestamps: true })).toBe('33:26 真实内容');
  });

  it('textToRows 把原版的纯文本转成结构化行', () => {
    expect(api.textToRows('0:02 hello\n1:05 world')).toEqual([
      { start: 2000, dur: 0, text: 'hello' },
      { start: 65_000, dur: 0, text: 'world' },
    ]);
  });

  it('formatStamp 与新版 formatTimestamp 同格式', () => {
    expect(api.formatStamp(0)).toBe('0:00');
    expect(api.formatStamp(65_000)).toBe('1:05');
    expect(api.formatStamp(3_661_000)).toBe('1:01:01');
    expect(api.formatStamp(-1)).toBe('--:--');
  });
});

describe('章节解析', () => {
  const { api } = loadShared();

  it('按时间码切分并清洗复述时长', () => {
    const text = [
      '0:00 Intro 0 seconds',
      '3:32 Chapter 1: What portrait painters can teach us about AI',
      '28:14 Chapter 2 later',
    ].join('\n');
    const chapters = api.parseChapters(text);
    expect(chapters.map((c) => c.start)).toEqual([0, 212_000, 1_694_000]);
    expect(chapters[1].text).toBe('Chapter 1: What portrait painters can teach us about AI');
  });

  it('只认章节面板，不把字幕面板抽样成章节', () => {
    // 字幕面板：每 3 秒一行，若按 30s 抽样会被误判成章节
    const transcript = Array.from({ length: 40 }, (_, i) => `${Math.floor(i / 20)}:${String((i * 3) % 60).padStart(2, '0')} line ${i}`).join('\n');
    const doc = fakeDoc({ 'PAmodern_transcript_view': transcript });
    expect(api.readChapterRows(doc)).toEqual([]);
  });

  it('从真实章节面板读出章节', () => {
    const doc = fakeDoc({
      'engagement-panel-macro-markers-description-chapters':
        'Chapters 0:00 Welcome to Rails World 2026 3:32 What portrait painters teach us 28:14 Closing thoughts',
    });
    const chapters = api.readChapterRows(doc);
    expect(chapters.map((c) => c.start)).toEqual([0, 212_000, 1_694_000]);
  });

  it('章节面板里混进密集字幕时也不会当成章节', () => {
    // 每 4 秒一行、持续 10 分钟：按 30s 抽样后间隔全挤在 30~40s
    const dense = Array.from({ length: 150 }, (_, i) => {
      const sec = i * 4;
      const stamp = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
      return `${stamp} subtitle line ${i}`;
    }).join('\n');
    const doc = fakeDoc({ 'engagement-panel-macro-markers-description-chapters': dense });
    expect(api.readChapterRows(doc)).toEqual([]);
  });

  it('章节视图复制不带字幕', () => {
    const chapters: TranscriptLine[] = [
      { start: 0, dur: 0, text: 'Intro' },
      { start: 212_000, dur: 0, text: 'Chapter 1' },
    ];
    expect(api.formatCopyText(rows(), { timestamps: true, view: 'chapters', chapters })).toBe(
      '0:00 Intro\n3:32 Chapter 1',
    );
    expect(api.formatCopyText(rows(), { timestamps: false, view: 'chapters', chapters })).toBe(
      'Intro\nChapter 1',
    );
  });

  it('没有章节时退回字幕，不会复制出空内容', () => {
    expect(api.formatCopyText(rows(), { timestamps: true, view: 'chapters', chapters: [] })).toBe(
      '0:00 hello there\n1:05 second line',
    );
  });
});

describe('共享偏好（两边同一个开关）', () => {
  it('默认带时间戳，且 setSharedPrefs 会写回 globalThis', () => {
    const { api, sandbox } = loadShared();
    expect(api.sharedPrefs().timestamps).toBe(true);
    api.setSharedPrefs({ timestamps: false, view: 'chapters' });
    const shared = sandbox.__yttSharedPrefs as { timestamps: boolean; view: string };
    expect(shared.timestamps).toBe(false);
    expect(shared.view).toBe('chapters');
    expect(api.sharedPrefs().timestamps).toBe(false);
  });
});

/** 假 DOM：只有 target-id 匹配的节点才会被 querySelectorAll 选中 */
function fakeDoc(panels: Record<string, string>): unknown {
  const nodes = Object.entries(panels).map(([targetId, innerText]) => ({
    tagName: 'YTD-ENGAGEMENT-PANEL-SECTION-LIST-RENDERER',
    innerText,
    textContent: innerText,
    getAttribute: (name: string) => (name === 'target-id' ? targetId : ''),
    querySelectorAll: () => [],
  }));

  return {
    querySelectorAll: (selector: string) => {
      // 逐个 selector 分支精确匹配 target-id，模拟真实选择器语义
      const wanted = Array.from(selector.matchAll(/target-id\*?="([^"]+)"/gu)).map((m) => m[1]);
      if (wanted.length === 0) return [];
      return nodes.filter((node) =>
        wanted.some((id) => node.getAttribute('target-id').includes(id)),
      );
    },
  };
}
