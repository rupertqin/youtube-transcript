import { describe, expect, it } from 'vitest';
import { collapseDuplicates } from '../src/core/dom/dedupe';
import { countTimecodes, parseTimecodeRows } from '../src/core/dom/text-rows';
import { looksLikeTranscript } from '../src/core/lines';
import { collectFromShape } from '../src/core/dom/scrape';
import { cacheKey } from '../src/core/cache';
import { parseTimecode } from '../src/core/dom/scrape';
import { applySelectorOverrides, DEFAULT_SELECTORS, getSelectors, resetSelectors } from '../src/core/dom/selectors';
import type { TranscriptLine } from '../src/core/types';

const line = (start: number, text: string): TranscriptLine => ({ start, dur: 0, text });

describe('时间码解析', () => {
  it('支持 m:ss 与 h:mm:ss', () => {
    expect(parseTimecode('1:23')).toBe(83_000);
    expect(parseTimecode('01:02:03')).toBe(3_723_000);
    expect(parseTimecode(' 0:00 ')).toBe(0);
  });

  it('非时间戳返回 null', () => {
    expect(parseTimecode('abc')).toBeNull();
    expect(parseTimecode('1:2:3:4')).toBeNull();
  });
});

describe('纯文本行解析（与标签名无关）', () => {
  it('时间码独占一行时，正文取后续行', () => {
    const raw = 'Search transcript\n17:14\nAnd it\'s clear we do\n17:21\nBut I\'d actually argue';
    const rows = parseTimecodeRows(raw);
    expect(rows).toEqual([
      { start: 1034000, dur: 0, text: "And it's clear we do" },
      { start: 1041000, dur: 0, text: "But I'd actually argue" },
    ]);
  });

  it('时间码与正文同一行', () => {
    const rows = parseTimecodeRows('0:01 hello world\n0:05 second line');
    expect(rows.map((row) => row.start)).toEqual([1000, 5000]);
    expect(rows[0].text).toBe('hello world');
  });

  it('正文跨多行时合并成一条', () => {
    const rows = parseTimecodeRows('1:00 first part\nwrapped part\n1:30 next');
    expect(rows).toHaveLength(2);
    expect(rows[0].text).toBe('first part wrapped part');
  });

  it('支持 h:mm:ss', () => {
    expect(parseTimecodeRows('1:02:03 late')[0]).toEqual({ start: 3723000, dur: 0, text: 'late' });
  });

  it('正文里出现的时间串不当作分割点', () => {
    const rows = parseTimecodeRows('0:10 we talked at 17:14 about it');
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe('we talked at 17:14 about it');
  });

  it('没有时间码时返回空，交给上层决定是否按纯文本收', () => {
    expect(parseTimecodeRows('just some words')).toEqual([]);
    expect(parseTimecodeRows('')).toEqual([]);
  });

  it('countTimecodes 只数行首时间码', () => {
    expect(countTimecodes('0:01 a\n0:05 b\nno stamp here')).toBe(2);
    expect(countTimecodes('we talked at 17:14')).toBe(0);
  });
});

describe('兜底文本的合法性校验', () => {
  const row = (text: string) => ({ start: 0, dur: 0, text });

  it('推荐位/播放列表的文本会被拒收（这条是 21 行推荐列表的真实样本）', () => {
    const recommendations = [
      row("/ 1:03:07 Rethinking HEY's be... Rails 27.6K subscribers Subscri... 1mo ago #rails #tech"),
      row('DHH has gone completely off the rails... Fireship 2.3M 1mo ago'),
      row('Andrej Karpathy: From Vibe Coding to Agentic Engineering w/ Stephanie Zhan Sequoia Capital 1.7M 6mo ago'),
      row('New The Nvidia Honey Trap Scandal, Explained | The Daily Show 5.7M 1d ago'),
      row('New #Ramayana | How BookMyShow Works? 1.2M 1h ago'),
    ];
    expect(looksLikeTranscript(recommendations)).toBe(false);
  });

  it('真正的字幕行通过', () => {
    const transcript = [
      row('All right, so the first thing I want to talk about is the fallback chain.'),
      row('Back in the middle of 2025, YouTube started enforcing a proof-of-origin token.'),
      row('That means a plain fetch returns HTTP 200 with an empty body.'),
      row('So the plan is: read the player response first, it usually has the tracks.'),
    ];
    expect(looksLikeTranscript(transcript)).toBe(true);
  });

  it('少量装饰词不影响判定', () => {
    const mixed = [
      row('we were talking about views per minute'),
      row('the second line has no markers at all'),
      row('third line is plain transcript text'),
      row('fourth line also plain transcript text'),
    ];
    expect(looksLikeTranscript(mixed)).toBe(true);
  });

  it('空数组不算字幕', () => {
    expect(looksLikeTranscript([])).toBe(false);
  });

  it('只有面板标题的 1~2 行不算字幕（这条脏数据曾进了缓存）', () => {
    expect(looksLikeTranscript([row('Transcript')])).toBe(false);
    expect(looksLikeTranscript([row('Transcript'), row('Chapters')])).toBe(false);
  });
});

describe('重复字幕兜底', () => {
  it('激进模式折叠连续重复', () => {
    const input = [line(0, 'a'), line(1000, 'a'), line(2000, 'b'), line(3000, 'b')];
    expect(collapseDuplicates(input, true).map((entry) => entry.text)).toEqual(['a', 'b']);
  });

  it('非激进模式保留连续重复', () => {
    const input = [line(0, 'a'), line(1000, 'a'), line(2000, 'b')];
    expect(collapseDuplicates(input, false)).toHaveLength(3);
  });

  it('前后两半完全相同只保留一半', () => {
    const half = [line(0, 'a'), line(1000, 'b'), line(2000, 'c'), line(3000, 'd')];
    expect(collapseDuplicates([...half, ...half], false)).toHaveLength(4);
  });

  it('少于两行原样返回', () => {
    const single = [line(0, 'a')];
    expect(collapseDuplicates(single, true)).toBe(single);
  });
});

describe('选择器覆盖', () => {
  it('只接受已知字段的字符串', () => {
    resetSelectors();
    const accepted = applySelectorOverrides({
      list: 'my-list',
      unknown: 'nope',
      stamp: 42,
    });
    expect(accepted).toEqual(['list']);
    expect(getSelectors().list).toBe('my-list');
    expect(getSelectors().stamp).toBe(DEFAULT_SELECTORS.stamp);
  });

  it('拒绝超长字符串', () => {
    resetSelectors();
    const accepted = applySelectorOverrides({ list: 'x'.repeat(500) });
    expect(accepted).toEqual([]);
    expect(getSelectors().list).toBe(DEFAULT_SELECTORS.list);
  });

  it('非对象输入不改动配置', () => {
    resetSelectors();
    expect(applySelectorOverrides('bad')).toEqual([]);
    expect(getSelectors()).toEqual(DEFAULT_SELECTORS);
  });
});

describe('缓存键', () => {
  it('带结构版本前缀：判定规则一改，旧条目自动失效', () => {
    expect(cacheKey('youtube', 'abcdefghijk')).toMatch(/^v\d+\|youtube\|abcdefghijk\|na\|manual$/u);
    expect(cacheKey('youtube', 'abcdefghijk', 'en', 'asr')).toMatch(/\|en\|asr$/u);
  });
});

describe('结构签名读取（与标签名无关）', () => {
  const fakeList = (rows: string[]) => ({ children: rows.map((text) => ({ textContent: text })) }) as unknown as Element;

  it('按「时间码 + 正文」逐行读出来', () => {
    const result = collectFromShape(
      fakeList(['0:17 Rails 2026 is set in Austin', '0:25 Let me start with why', '1:02:03 late line']),
    );
    expect(result.lines).toEqual([
      { start: 17000, dur: 0, text: 'Rails 2026 is set in Austin' },
      { start: 25000, dur: 0, text: 'Let me start with why' },
      { start: 3723000, dur: 0, text: 'late line' },
    ]);
    expect(result.showTimestamps).toBe(true);
  });

  it('推荐列表那种「标题开头」的行一条都不收', () => {
    const result = collectFromShape(
      fakeList(['Rethinking HEY backend with agents 30:24', 'DHH off the rails 6:44']),
    );
    expect(result.lines).toEqual([]);
  });

  it('没有时间码的行跳过，不产生假数据', () => {
    expect(collectFromShape(fakeList(['Transcript', 'Chapters'])).lines).toEqual([]);
  });
});
