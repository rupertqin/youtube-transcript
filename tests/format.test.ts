import { describe, expect, it } from 'vitest';
import {
  buildExport,
  fileExtension,
  formatTimestamp,
  slugifyTitle,
  toMarkdown,
  toPlainText,
  toSrt,
} from '../src/core/format/export';
import type { TranscriptLine } from '../src/core/types';
import { findActiveIndex } from '../src/core/lines';

const lines: TranscriptLine[] = [
  { start: 0, dur: 1500, text: '第一行' },
  { start: 1500, dur: 0, text: 'second line' },
  { start: 65000, dur: 2000, text: 'third' },
];

describe('时间戳格式化', () => {
  it('10 分钟内用 m:ss，超过 1 小时补小时', () => {
    expect(formatTimestamp(0)).toBe('0:00');
    expect(formatTimestamp(65_000)).toBe('1:05');
    expect(formatTimestamp(3_661_000)).toBe('1:01:01');
  });

  it('未知时间返回占位符', () => {
    expect(formatTimestamp(-1)).toBe('--:--');
  });
});

describe('导出格式', () => {
  it('纯文本可切换时间戳', () => {
    expect(toPlainText(lines, { timestamps: true })).toContain('1:05 third');
    expect(toPlainText(lines, { timestamps: false })).toBe('第一行\nsecond line\nthird');
  });

  it('时间戳未知的行不加前缀', () => {
    const withUnknown: TranscriptLine[] = [{ start: -1, dur: 0, text: 'no time' }];
    expect(toPlainText(withUnknown, { timestamps: true })).toBe('no time');
  });

  it('SRT 用 dur，缺失时用下一行起点补齐', () => {
    const srt = toSrt(lines);
    expect(srt.startsWith('1\n00:00:00,000 --> 00:00:01,500\n第一行')).toBe(true);
    expect(srt).toContain('00:00:01,500 --> 00:01:05,000');
    expect(srt).toContain('00:01:05,000 --> 00:01:07,000');
  });

  it('Markdown 带元信息头', () => {
    const md = toMarkdown(lines, {
      title: 'Demo',
      videoId: 'abc',
      url: 'https://www.youtube.com/watch?v=abc',
      lang: 'zh-Hans',
      source: 'intercept',
    });
    expect(md).toContain('# Demo');
    expect(md).toContain('**[1:05]** third');
    expect(md).toContain('- Lines: 3');
  });

  it('JSON 可被解析回结构', () => {
    const json = JSON.parse(
      buildExport('json', lines, { title: 'Demo', videoId: 'abc', url: 'u' }, true),
    ) as { lines: TranscriptLine[]; title: string };
    expect(json.title).toBe('Demo');
    expect(json.lines).toHaveLength(3);
  });

  it('扩展名映射', () => {
    expect(fileExtension('md')).toBe('md');
    expect(fileExtension('txt')).toBe('txt');
    expect(fileExtension('srt')).toBe('srt');
  });
});

describe('文件名 slug', () => {
  it('去掉非法字符并压缩空白', () => {
    expect(slugifyTitle('a/b:c*d? "e"')).toBe('a-b-c-d-e');
    expect(slugifyTitle('   ')).toBe('transcript');
  });
});

describe('播放行定位', () => {
  it('二分命中当前行', () => {
    expect(findActiveIndex(lines, 0)).toBe(0);
    expect(findActiveIndex(lines, 1.6)).toBe(1);
    expect(findActiveIndex(lines, 100)).toBe(2);
  });

  it('第一行之前返回 -1', () => {
    expect(findActiveIndex([{ start: 5000, dur: 100, text: 'x' }], 1)).toBe(-1);
    expect(findActiveIndex([], 10)).toBe(-1);
  });
});
