import { describe, expect, it } from 'vitest';
import { cleanLines } from '../src/core/format/copy';
import { toSrt } from '../src/core/format/export';
import { mergeFragments } from '../src/core/lines';
import type { TranscriptLine } from '../src/core/types';

/**
 * YouTube 原生面板显示的不是原始分段：它把连续几段合成一条，只在行首留一个
 * 时间码。我们把 get_transcript 的每个 segment 单独渲染，于是同一份数据「特别散」。
 *
 * 分组判据只能来自数据本身。手头有的信号：
 * - 开始时间（有）；
 * - 结束时间（不可靠，`endMs` 常缺失或盖过下一段）→ 算不出停顿；
 * - 句末标点（大多数碎片没有）→ 没法按句子切。
 *
 * 剩下的稳定信号是**时间跨度**，这也正是原生面板的做法：同一份数据里
 * 原生面板每一条覆盖 7–8 秒（0:00→0:08 两段、0:08→0:15 四段、0:20→0:28 两段），
 * 字符数从 20 到 149 完全不固定。所以这里一行攒满约 8 秒就换行。
 */

const line = (start: number, text: string, dur = 1_800): TranscriptLine => ({ start, dur, text });

describe('mergeFragments：一行约 8 秒', () => {
  it('连续的短分段合成一行，保留首段 start', () => {
    const rows = [
      line(0, 'Welcome to The Daily Show.'),
      line(2_000, 'Let me tell you something.'),
      line(4_000, 'My name is Jon Stewart.'),
      line(6_000, 'Unbelievable show tonight.'),
    ];

    const merged = mergeFragments(rows);

    expect(merged).toHaveLength(1);
    expect(merged[0].start).toBe(0);
    expect(merged[0].text).toBe(
      'Welcome to The Daily Show. Let me tell you something. My name is Jon Stewart. Unbelievable show tonight.',
    );
  });

  it('合并后 dur 覆盖到末段结束时间，SRT 不会把段落截短', () => {
    const rows = [line(0, 'First fragment.'), line(2_000, 'Second fragment.')];
    const merged = mergeFragments(rows);

    expect(merged[0].dur).toBe(2_000 + 1_800);
    const srt = toSrt(merged);
    expect(srt).toContain('00:00:00,000 --> 00:00:03,800');
    expect(srt).toContain('First fragment. Second fragment.');
  });

  it('跨度到 8 秒就换行，与原生面板的分组一致', () => {
    const texts = [
      'Welcome to The Daily Show.',
      'Let me tell you something.',
      "I am so excited that you've joined us tonight.",
      'My name is Jon Stewart.',
      'Unbelievable show for you tonight.',
      'Rachel Maddow is going to be joining us later.',
      '[CHEERING, APPLAUSE]',
      'Jon Stewart and Rachel Maddow, liberal wet dream.',
      'I dreamed, I dreamed about this.',
    ];
    const starts = [0, 6_000, 8_000, 10_000, 11_000, 13_000, 15_000, 20_000, 26_000];
    const rows = starts.map((start, i) => line(start, texts[i]));

    const merged = mergeFragments(rows);

    // 原生面板：0:00 两段、0:08 四段、0:15 音效、0:20 两段
    expect(merged.map((l) => l.start)).toEqual([0, 8_000, 15_000, 20_000]);
    expect(merged[0].text).toBe(texts.slice(0, 2).join(' '));
    expect(merged[1].text).toBe(texts.slice(2, 6).join(' '));
    expect(merged[2].text).toBe('[CHEERING, APPLAUSE]');
    expect(merged[3].text).toBe(texts.slice(7, 9).join(' '));
  });

  it('章节之间隔几分钟：跨度判据自然把行断开', () => {
    const rows = [
      line(0, '第一章第一句。'),
      line(2_000, '第一章第二句。'),
      line(300_000, '第二章第一句。'),
    ];

    const merged = mergeFragments(rows);

    expect(merged).toHaveLength(2);
    expect(merged[0].text).toBe('第一章第一句。第一章第二句。');
    expect(merged[1].start).toBe(300_000);
  });

  it('[音效/舞台提示] 独立成行，且不与前后台词合并', () => {
    const rows = [
      line(0, 'Welcome back.'),
      line(3_000, '[CHEERING, APPLAUSE]'),
      line(6_000, 'Thank you.'),
    ];

    const merged = mergeFragments(rows);

    expect(merged).toHaveLength(3);
    expect(merged[1].text).toBe('[CHEERING, APPLAUSE]');
    expect(merged[1].start).toBe(3_000);
  });

  it('中文拼接不加空格，英文拼接补一个空格', () => {
    expect(mergeFragments([line(0, '你好'), line(2_000, '世界')])[0].text).toBe('你好世界');
    expect(mergeFragments([line(0, 'Hello'), line(2_000, 'world')])[0].text).toBe('Hello world');
    expect(mergeFragments([line(0, '中文'), line(2_000, 'and English')])[0].text).toBe('中文and English');
  });

  it('时间码异常（多段挤在同一秒）时用字数兜底，不滚成一整块', () => {
    // 跨度永远是 0，只有字数上限能拦住
    const rows = Array.from({ length: 8 }, (_, i) => line(0, `segment ${i} ${'x'.repeat(40)}`));

    const merged = mergeFragments(rows);

    expect(merged.length).toBeGreaterThan(1);
    for (const row of merged) {
      expect(row.text.length).toBeLessThanOrEqual(240);
    }
  });

  it('没有时间码的行单独成行；空数组返回空', () => {
    const rows = [
      { start: -1, dur: 0, text: '无时间码' },
      { start: -1, dur: 0, text: '另一行' },
    ];
    expect(mergeFragments(rows)).toHaveLength(2);
    expect(mergeFragments([])).toEqual([]);
  });

  it('清洗只做文本归一化、不合并：缓存里存的是原始分段', () => {
    const rows = [line(0, '第一句'), line(2_000, '第二句'), line(4_000, '第三句')];

    const cleaned = cleanLines(rows);
    // 关键：缓存写的是 cleaned（3 行），展示才 merge（1 行），
    // 命中缓存时不会二次合并导致行越粘越长
    expect(cleaned).toHaveLength(3);
    expect(cleaned).toEqual(rows);
    expect(mergeFragments(cleaned)).toHaveLength(1);
    expect(mergeFragments(cleaned)[0].text).toBe('第一句第二句第三句');
  });

  it('带无障碍时长复述的行在清洗后仍是独立分段', () => {
    const rows = [
      line(2_006_000, '33 minutes, 26 seconds 正文'),
      line(2_008_000, '下一段'),
    ];
    const cleaned = cleanLines(rows);

    expect(cleaned[0].text).toBe('正文');
    expect(cleaned).toHaveLength(2);
  });
});

/**
 * 分组只看 `start`，与 `dur` 完全无关。
 * 真实数据里 `endMs` / `dDurationMs` 有重叠、超长、缺失三种形态，
 * 分组必须一模一样，否则同一份字幕在不同来源下会长得不一样。
 */
describe('mergeFragments：分组不随 dur 形态变化', () => {
  const texts = [
    'Welcome to The Daily Show.',
    'Let me tell you something.',
    "I am so excited that you've joined us tonight.",
    'My name is Jon Stewart.',
    'Unbelievable show for you tonight.',
    'Rachel Maddow is going to be joining us later.',
    '[CHEERING, APPLAUSE]',
    'Jon Stewart and Rachel Maddow, liberal wet dream.',
    'I dreamed, I dreamed about this.',
  ];
  const starts = [0, 6_000, 8_000, 10_000, 11_000, 13_000, 15_000, 20_000, 26_000];

  const shapes: [string, (i: number) => number][] = [
    ['endMs 恰好等于下一段起点', (i) => (i < starts.length - 1 ? starts[i + 1] - starts[i] : 2_000)],
    ['endMs 重叠到下一段之后', (i) => (i < starts.length - 1 ? starts[i + 1] - starts[i] + 1_500 : 3_500)],
    ['timedtext 的超长 dDurationMs', () => 6_000],
    ['dur 全部缺失（0）', () => 0],
  ];

  for (const [label, durOf] of shapes) {
    it(`${label}：9 段分组完全一致`, () => {
      const merged = mergeFragments(
        starts.map((start, i) => ({ start, dur: durOf(i), text: texts[i] })),
      );

      expect(merged.map((l) => l.start)).toEqual([0, 8_000, 15_000, 20_000]);
      expect(merged[0].text).toBe(texts.slice(0, 2).join(' '));
      expect(merged[1].text).toBe(texts.slice(2, 6).join(' '));
      // SRT 用的 dur 至少覆盖到组内最后一段
      expect(merged[0].dur).toBeGreaterThan(6_000);
    });
  }
});
