import { describe, expect, it } from 'vitest';
import { findChapterIndex } from '../src/core/lines';
import type { TranscriptLine } from '../src/core/types';

/** 真实章节：0:00 / 3:32 / 28:14 / 33:04 */
const chapters: TranscriptLine[] = [
  { start: 0, dur: 0, text: 'Intro' },
  { start: 212_000, dur: 0, text: 'Chapter 1' },
  { start: 1_694_000, dur: 0, text: 'Chapter 2' },
  { start: 1_984_000, dur: 0, text: 'Chapter 3' },
];

describe('章节高亮定位', () => {
  it('播放位置正好落在章节起点时，高亮的是这一章而不是上一章', () => {
    // 这是用户报的 bug：点 28:14 却高亮 3:32
    expect(findChapterIndex(chapters, 1_694_000)).toBe(2);
  });

  it('章节之间插值也高亮当前章', () => {
    expect(findChapterIndex(chapters, 1_694_000 + 30_000)).toBe(2);
    expect(findChapterIndex(chapters, 1_984_000 - 1)).toBe(2);
  });

  it('起点之前（章节未开始时）回落到 0:00 那一章', () => {
    expect(findChapterIndex(chapters, 0)).toBe(0);
    expect(findChapterIndex(chapters, 1000)).toBe(0);
    expect(findChapterIndex(chapters, 211_999)).toBe(0);
  });

  it('刚好跨到下一章的那一毫秒就切换', () => {
    expect(findChapterIndex(chapters, 1_693_999)).toBe(1);
    expect(findChapterIndex(chapters, 1_694_001)).toBe(2);
  });

  it('位置未知或没有章节时返回 -1', () => {
    expect(findChapterIndex(chapters, -1)).toBe(-1);
    expect(findChapterIndex([], 5000)).toBe(-1);
  });

  it('字幕行的 start 早于章节起点时，用行起点会算错（回归守卫）', () => {
    // 28:14 章节前最后一条字幕行是 28:09，拿它当播放位置就会落到上一章
    const lineStart = 1_689_000;
    expect(findChapterIndex(chapters, lineStart)).toBe(1);
    // 而真实播放位置是 28:14，正确结果是第 2 章
    expect(findChapterIndex(chapters, 1_694_000)).toBe(2);
  });
});
