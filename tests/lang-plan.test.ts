import { describe, expect, it } from 'vitest';
import {
  langMatches,
  LANG_CHOICES,
  pickUsableChoice,
  resolveLangPlan,
} from '../src/core/langs';
import { buildTimedTextUrl, fetchTimedText } from '../src/core/harvest/timedtext';

/**
 * 字幕语言选择。
 *
 * 需求：可选英文 / 中文，默认「同音频」（不翻译，用视频自己的轨道）。
 * 规则：目标语言有原生轨道就用原生的，没有才让 YouTube 机器翻译（tlang）。
 */

describe('resolveLangPlan', () => {
  it('默认同音频：不翻译，轨道顺序跟随浏览器', () => {
    const plan = resolveLangPlan('auto');
    expect(plan.tlang).toBeNull();
    expect(plan.langs.length).toBeGreaterThan(0);
  });

  it('选中文：优先原生中文轨道，兜底走 zh-Hans 翻译', () => {
    const plan = resolveLangPlan('zh');
    expect(plan.tlang).toBe('zh-Hans');
    expect(plan.langs[0]).toBe('zh-Hans');
    // 原生中文没有时，至少还能落到英文再翻译
    expect(plan.langs).toContain('en');
  });

  it('选英文：目标就是 en', () => {
    const plan = resolveLangPlan('en');
    expect(plan.tlang).toBe('en');
    expect(plan.langs[0]).toBe('en');
  });

  it('三个选项的顺序固定为 同音频 → 中文 → English', () => {
    expect(LANG_CHOICES).toEqual(['auto', 'zh', 'en']);
  });
});

describe('pickUsableChoice：视频给不了就退回同音频', () => {
  it('同音频永远有效', () => {
    expect(pickUsableChoice('auto', ['en'])).toBe('auto');
  });

  it('有中文（含繁体）时保留中文选择', () => {
    expect(pickUsableChoice('zh', ['en', 'zh-hans'])).toBe('zh');
    expect(pickUsableChoice('zh', ['zh-hant'])).toBe('zh');
  });

  it('视频没有中文时退回同音频，和按钮的禁用状态一致', () => {
    expect(pickUsableChoice('zh', ['en', 'ja'])).toBe('auto');
  });

  it('还没读到轨道信息时不擅自降级', () => {
    expect(pickUsableChoice('zh', [])).toBe('zh');
  });
});

describe('langMatches', () => {
  it('主语言相同即算满足（zh-Hant 也算中文）', () => {
    expect(langMatches('zh-Hant', 'zh-Hans')).toBe(true);
    expect(langMatches('zh', 'zh-Hans')).toBe(true);
    expect(langMatches('en-US', 'en')).toBe(true);
  });

  it('不同语言不算满足', () => {
    expect(langMatches('ja', 'zh-Hans')).toBe(false);
    expect(langMatches('en', 'zh-Hans')).toBe(false);
  });

  it('缺任一侧时不算满足', () => {
    expect(langMatches(null, 'zh-Hans')).toBe(false);
    expect(langMatches('zh', null)).toBe(false);
  });
});

describe('timedtext 的 tlang 参数', () => {
  const base = 'https://www.youtube.com/api/timedtext?v=abc&lang=en&kind=asr&exp=x';

  it('不翻译时不带 tlang', () => {
    expect(buildTimedTextUrl(base, 'json3')).not.toContain('tlang');
  });

  it('翻译时把 tlang 拼进 URL，同时保留原有参数', () => {
    const url = buildTimedTextUrl(base, 'json3', 'zh-Hans');
    expect(url).toContain('tlang=zh-Hans');
    expect(url).toContain('v=abc');
    expect(url).toContain('fmt=json3');
  });

  it('fetchTimedText 会把 tlang 透传到请求上', async () => {
    let requested = '';
    const fakeFetch = (async (input: string) => {
      requested = String(input);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: '你好' }] }] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const outcome = await fetchTimedText(fakeFetch, base, 'json3', new AbortController().signal, 'zh-Hans');
    expect(requested).toContain('tlang=zh-Hans');
    expect(outcome.lines.length).toBeGreaterThan(0);
  });
});
