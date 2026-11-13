import { describe, expect, it } from 'vitest';
import { stripA11yDuration } from '../src/core/format/a11y';
import { parseChapters, readChapterRows } from '../src/core/format/chapters';
import { cleanLines, formatCopyText } from '../src/core/format/copy';
import { formatTimestamp, toSrt } from '../src/core/format/export';
import { mergeFragments } from '../src/core/lines';
import { parseTimecodeRows } from '../src/core/dom/text-rows';
import type { TranscriptLine } from '../src/core/types';

/**
 * 复制 / 清洗 / 章节解析的唯一实现，这里测的就是产物真正跑的那份代码。
 */

const rows = (): TranscriptLine[] => [
  { start: 0, dur: 0, text: 'hello there' },
  { start: 65_000, dur: 0, text: 'second line' },
];

/**
 * 假的章节面板容器。
 *
 * `deepQueryAll` 用的是 `querySelectorAll('...target-id*="xxx"...')`，
 * 所以这里按 `target-id` 做子串匹配，足够覆盖真实选择器。
 */
function fakeDoc(panels: Record<string, string>): Document {
  const elements = Object.entries(panels).map(([targetId, text]) => ({
    tagName: 'DIV',
    innerText: text,
    textContent: text,
    getAttribute: (name: string) => (name === 'target-id' ? targetId : null),
    querySelectorAll: () => [],
  }));

  return {
    querySelectorAll: (selector: string) => {
      const wanted = [...selector.matchAll(/target-id\*="([^"]+)"/gu)].map((m) => m[1]);
      if (wanted.length === 0) return [];
      return elements.filter((el) => wanted.some((w) => String(el.getAttribute('target-id')).includes(w)));
    },
    body: { innerText: '', textContent: '' },
  } as unknown as Document;
}

describe('无障碍时长清洗（复制里 33:26 后面那串）', () => {
  it('删掉与时间码数值一致的复述', () => {
    expect(stripA11yDuration('33:26 33 minutes, 26 seconds')).toBe('33:26');
    expect(stripA11yDuration('33:26 33 minutes, 26 seconds 正文在这里')).toBe('33:26 正文在这里');
    expect(stripA11yDuration('1:01:01 1 hour, 1 minute, 1 second done')).toBe('1:01:01 done');
  });

  it('处理 YouTube 那种没有空格的粘连', () => {
    expect(stripA11yDuration("3:32 3 minutes, 32 secondsI don't know")).toBe("3:32 I don't know");
  });

  it('独占一行的复述也去掉', () => {
    expect(stripA11yDuration('0:05 正文\n5 seconds')).toBe('0:05 正文');
  });

  it('数值对不上的正常字幕不动', () => {
    // 这是真实台词，不是 0:83 的复述
    expect(stripA11yDuration('1:23 we waited 5 minutes for the build')).toBe(
      '1:23 we waited 5 minutes for the build',
    );
    expect(stripA11yDuration('10:00 only 2 seconds left')).toBe('10:00 only 2 seconds left');
  });

  it('时间码已经在 start 里时，靠 expectedMs 对上', () => {
    expect(stripA11yDuration('33 minutes, 26 seconds 真实内容', 2006_000)).toBe('真实内容');
  });
});

describe('复制文本格式化', () => {
  it('带时间戳', () => {
    expect(formatCopyText(rows(), { timestamps: true })).toBe('0:00 hello there\n1:05 second line');
  });

  it('不带时间戳', () => {
    expect(formatCopyText(rows(), { timestamps: false })).toBe('hello there\nsecond line');
  });

  it('复制时顺手清洗复述时长', () => {
    const dirty: TranscriptLine[] = [
      { start: 2006_000, dur: 0, text: '33 minutes, 26 seconds 真实内容' },
    ];
    expect(formatCopyText(dirty, { timestamps: true })).toBe('33:26 真实内容');
  });

  it('parseTimecodeRows 把纯文本转成结构化行', () => {
    expect(parseTimecodeRows('0:02 hello\n1:05 world')).toEqual([
      { start: 2000, dur: 0, text: 'hello' },
      { start: 65_000, dur: 0, text: 'world' },
    ]);
  });

  it('时间戳格式与面板一致', () => {
    expect(formatTimestamp(0)).toBe('0:00');
    expect(formatTimestamp(65_000)).toBe('1:05');
    expect(formatTimestamp(3_661_000)).toBe('1:01:01');
    expect(formatTimestamp(-1)).toBe('--:--');
  });
});

describe('句子合并后的复制 / 导出', () => {
  // 面板、搜索、复制、导出都消费 store.state.lines —— 合并后的那一份
  const fragments = (): TranscriptLine[] => [
    { start: 0, dur: 1_800, text: 'Welcome to The Daily Show.' },
    { start: 2_000, dur: 1_800, text: 'Let me tell you something.' },
    { start: 4_000, dur: 1_800, text: 'My name is Jon Stewart.' },
  ];

  it('复制只带首段时间码，正文是一整句而不是三行碎片', () => {
    const display = mergeFragments(cleanLines(fragments()));
    expect(display).toHaveLength(1);
    expect(formatCopyText(display, { timestamps: true })).toBe(
      '0:00 Welcome to The Daily Show. Let me tell you something. My name is Jon Stewart.',
    );
  });

  it('SRT 的结束时间覆盖到合并后的末段，不会截在第一段', () => {
    const display = mergeFragments(cleanLines(fragments()));
    expect(display[0].dur).toBe(5_800);
    expect(toSrt(display)).toContain('00:00:00,000 --> 00:00:05,800');
  });
});

describe('章节解析', () => {
  it('按时间码切分并清洗复述时长', () => {
    const text = [
      '0:00 Intro 0 seconds',
      '3:32 Chapter 1: What portrait painters can teach us about AI',
      '28:14 Chapter 2 later',
    ].join('\n');
    const chapters = parseChapters(text);
    expect(chapters.map((c) => c.start)).toEqual([0, 212_000, 1_694_000]);
    expect(chapters[1].text).toBe('Chapter 1: What portrait painters can teach us about AI');
  });

  it('只认章节面板，不把字幕面板抽样成章节', () => {
    // 字幕面板：每 3 秒一行，若按 30s 抽样会被误判成章节
    const transcript = Array.from(
      { length: 40 },
      (_, i) => `${Math.floor(i / 20)}:${String((i * 3) % 60).padStart(2, '0')} line ${i}`,
    ).join('\n');
    const doc = fakeDoc({ PAmodern_transcript_view: transcript });
    expect(readChapterRows(doc)).toEqual([]);
  });

  it('从真实章节面板读出章节', () => {
    const doc = fakeDoc({
      'engagement-panel-macro-markers-description-chapters':
        'Chapters 0:00 Welcome to Rails World 2026 3:32 What portrait painters teach us 28:14 Closing thoughts',
    });
    const chapters = readChapterRows(doc);
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
    expect(readChapterRows(doc)).toEqual([]);
  });

  it('章节视图复制不带字幕', () => {
    const chapters: TranscriptLine[] = [
      { start: 0, dur: 0, text: 'Intro' },
      { start: 212_000, dur: 0, text: 'Chapter 1' },
    ];
    expect(formatCopyText(rows(), { timestamps: true, view: 'chapters', chapters })).toBe(
      '0:00 Intro\n3:32 Chapter 1',
    );
    expect(formatCopyText(rows(), { timestamps: false, view: 'chapters', chapters })).toBe(
      'Intro\nChapter 1',
    );
  });

  it('没有章节时退回字幕，不会复制出空内容', () => {
    expect(formatCopyText(rows(), { timestamps: true, view: 'chapters', chapters: [] })).toBe(
      '0:00 hello there\n1:05 second line',
    );
  });
});
