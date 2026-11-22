import { describe, expect, it } from 'vitest';
import { biliError, noSubtitleDetail } from '../src/core/site/bilibili/errors';
import {
  biliVideoKey,
  normalizeLang,
  normalizeTrack,
  parseBiliVideoId,
  parseSubtitleBody,
  pickBiliTrack,
  splitBiliVideoKey,
  trackScore,
  type BiliTrack,
} from '../src/core/site/bilibili/parse';

describe('BV 号解析（含分 P）', () => {
  it('普通视频页', () => {
    expect(parseBiliVideoId('https://www.bilibili.com/video/BV1xx411c7mD/?spm=333')).toEqual({
      bvid: 'BV1xx411c7mD',
      page: 1,
    });
  });

  it('分 P 取 ?p=', () => {
    expect(parseBiliVideoId('https://www.bilibili.com/video/BV1xx411c7mD?p=3&vd_source=x')).toEqual({
      bvid: 'BV1xx411c7mD',
      page: 3,
    });
  });

  it('非视频页返回 null', () => {
    expect(parseBiliVideoId('https://www.bilibili.com/')).toBeNull();
    expect(parseBiliVideoId('https://www.bilibili.com/bangumi/play/ep123')).toBeNull();
  });

  it('videoId 必须带分 P，否则第 2 P 会命中第 1 P 的缓存', () => {
    expect(biliVideoKey('BV1xx411c7mD', 1)).toBe('BV1xx411c7mD');
    expect(biliVideoKey('BV1xx411c7mD', 2)).toBe('BV1xx411c7mD:p2');
    expect(splitBiliVideoKey('BV1xx411c7mD:p2')).toEqual({ bvid: 'BV1xx411c7mD', page: 2 });
    expect(splitBiliVideoKey('BV1xx411c7mD')).toEqual({ bvid: 'BV1xx411c7mD', page: 1 });
    expect(splitBiliVideoKey('nope')).toBeNull();
  });
});

describe('轨道归一化', () => {
  it('AI 中文归到 zh-Hans/asr，投稿轨归到 manual', () => {
    expect(normalizeLang('ai-zh')).toBe('zh-Hans');
    expect(normalizeLang('zh-CN')).toBe('zh-Hans');
    expect(normalizeLang('zh-TW')).toBe('zh-Hant');
    expect(normalizeLang('ai-en')).toBe('en');
    expect(normalizeLang('en-US')).toBe('en-us');
  });

  it('protocol-relative 字幕地址补上 https', () => {
    const track = normalizeTrack({ lan: 'ai-zh', type: 1, subtitle_url: '//aisubtitle.hdslb.com/x.json' });
    expect(track.baseUrl).toBe('https://aisubtitle.hdslb.com/x.json');
    expect(track.languageCode).toBe('zh-Hans');
    expect(track.kind).toBe('asr');
    expect(track.ai).toBe(true);
  });

  it('人工轨分数高于 AI 轨', () => {
    expect(trackScore({ lan: 'zh-CN', type: 0, subtitle_url: 'a' })).toBeGreaterThan(
      trackScore({ lan: 'ai-zh', type: 1, subtitle_url: 'a' }),
    );
  });
});

describe('挑轨道', () => {
  const tracks: BiliTrack[] = [
    { lan: 'ai-zh', type: 1, subtitle_url: 'ai.json' },
    { lan: 'zh-CN', type: 0, subtitle_url: 'cn.json' },
    { lan: 'en-US', type: 0, subtitle_url: 'en.json' },
  ];

  it('默认挑质量最高的一条（人工中文）', () => {
    expect(pickBiliTrack(tracks)?.subtitle_url).toBe('cn.json');
  });

  it('用户选了 English 就给英文轨', () => {
    expect(pickBiliTrack(tracks, 'en')?.subtitle_url).toBe('en.json');
  });

  it('该视频没有目标语言时退回最高分，而不是假装有', () => {
    expect(pickBiliTrack(tracks, 'zh')?.subtitle_url).toBe('cn.json');
    expect(pickBiliTrack([{ lan: 'ai-zh', type: 1, subtitle_url: 'ai.json' }], 'en')?.lan).toBe('ai-zh');
  });

  it('subtitle_url 为空的轨道直接排除（AI 还在生成）', () => {
    expect(pickBiliTrack([{ lan: 'ai-zh', type: 1, subtitle_url: '' }])).toBeNull();
  });
});

describe('字幕体解析', () => {
  it('秒转毫秒、剥内联标签、丢空行', () => {
    const lines = parseSubtitleBody({
      body: [
        { from: 0.5, to: 2.25, content: '第一句' },
        { from: 2.25, to: 3, content: '<b>第二句</b>' },
        { from: 3, to: 4, content: '   ' },
        { from: 4, to: 5.5, content: '多行\n内容' },
      ],
    });
    expect(lines).toEqual([
      { start: 500, dur: 1_750, text: '第一句' },
      { start: 2_250, dur: 750, text: '第二句' },
      { start: 4_000, dur: 1_500, text: '多行 内容' },
    ]);
  });

  it('结构不对时返回空数组而不是抛错', () => {
    expect(parseSubtitleBody(null)).toEqual([]);
    expect(parseSubtitleBody({ body: 'nope' })).toEqual([]);
  });
});

describe('错误映射', () => {
  it('-101 说清是「要登录」而不是「没有字幕」', () => {
    const mapped = biliError(-101, '账号未登录');
    expect(mapped.code).toBe('NO_CAPTION_TRACK');
    expect(mapped.detail).toContain('登录');
  });

  it('-352 当作风控，提示稍后重试', () => {
    expect(biliError(-352).code).toBe('RATE_LIMITED');
    expect(biliError(-352).detail).toContain('风控');
  });

  it('无字幕的说明里包含 AI 生成中的可能', () => {
    expect(noSubtitleDetail()).toContain('生成');
  });
});
