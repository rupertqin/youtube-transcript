import { describe, expect, it } from 'vitest';
import { cleanLines } from '../src/core/format/copy';
import { toSrt } from '../src/core/format/export';
import { mergeFragments } from '../src/core/lines';
import type { TranscriptLine } from '../src/core/types';

/**
 * YouTube 原生面板显示的不是原始 ASR 分段：它把连续几段合成一条，
 * 只在段落开头留一个时间码。我们把 get_transcript 的每个 segment 单独渲染，
 * 于是同一份数据显得「特别散」。这里测的就是补上的那一步。
 */

const line = (start: number, text: string, dur = 1_800): TranscriptLine => ({ start, dur, text });

describe('mergeFragments：把 ASR 碎片拼成可读句子', () => {
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

  it('长停顿（>8s）切开，不会把隔了半分钟的两句话粘成一条', () => {
    const rows = [line(0, 'Opening line.', 1_000), line(20_000, 'After a long pause.', 1_000)];

    const merged = mergeFragments(rows);

    expect(merged).toHaveLength(2);
    expect(merged[1].start).toBe(20_000);
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

  it('超长或跨度过大时停止合并，避免滚成一整块', () => {
    const rows = [line(0, 'A'.repeat(90)), line(2_000, 'B'.repeat(90)), line(4_000, 'C'.repeat(90))];

    const merged = mergeFragments(rows);
    expect(merged.length).toBe(3);

    const wide = mergeFragments([line(0, 'first'), line(11_000, 'second')], { maxSpanMs: 10_000 });
    expect(wide).toHaveLength(2);
  });

  it('没有时间码的行不参与合并；空数组直接返回空', () => {
    const rows = [
      { start: -1, dur: 0, text: '无时间码' },
      { start: -1, dur: 0, text: '另一行' },
    ];
    expect(mergeFragments(rows)).toHaveLength(2);
    expect(mergeFragments([])).toEqual([]);
  });

  it('保持时间顺序，不修改入参', () => {
    const rows = [line(0, 'first'), line(2_000, 'second')];
    const merged = mergeFragments(rows);

    expect(merged[0].start).toBe(0);
    expect(merged[0].dur).toBeGreaterThan(rows[0].dur);
    expect(rows[0].text).toBe('first');
    expect(rows[1].text).toBe('second');
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
