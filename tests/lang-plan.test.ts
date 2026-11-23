import { describe, expect, it } from 'vitest';
import {
  langMatches,
  LANG_CHOICES,
  pickUsableChoice,
  preferOwnLangs,
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

  it('站点不能机翻时：没有中文就退回同音频，和按钮的禁用状态一致', () => {
    expect(pickUsableChoice('zh', ['en', 'ja'])).toBe('auto');
    expect(pickUsableChoice('zh', ['en', 'ja'], false)).toBe('auto');
  });

  it('站点能机翻（YouTube 播放器机翻）时不降级：点中文就给中文', () => {
    expect(pickUsableChoice('zh', ['en'], true)).toBe('zh');
    expect(pickUsableChoice('en', ['zh-Hans'], true)).toBe('en');
  });

  it('还没读到轨道信息时不擅自降级', () => {
    expect(pickUsableChoice('zh', [])).toBe('zh');
    expect(pickUsableChoice('zh', [], true)).toBe('zh');
  });
});

/**
 * 「同音频」= 跟随视频，不是跟随浏览器。
 *
 * 中文浏览器打开日文视频时，按浏览器语言会先去要中文（拿不到就机翻），
 * 而那并不是视频的听写 —— 必须把视频音轨自己的语言排到最前。
 */
describe('preferOwnLangs：同音频优先用视频自己的听写', () => {
  it('把音轨语言排到最前，其余顺序保留且去重', () => {
    const next = preferOwnLangs(resolveLangPlan('auto'), ['ja']);
    expect(next.langs[0]).toBe('ja');
    expect(next.tlang).toBeNull();
    expect(new Set(next.langs).size).toBe(next.langs.length);
  });

  it('音轨是中文时，浏览器偏好的 zh 不会重复出现', () => {
    const next = preferOwnLangs(resolveLangPlan('auto'), ['zh-hant']);
    expect(next.langs[0]).toBe('zh-hant');
    // zh-Hant 与 zh / zh-Hans 主语言相同，只保留一条
    expect(next.langs.filter((code) => code.startsWith('zh')).length).toBe(1);
  });

  it('指定了产出语言时不动（不能被视频语言带偏）', () => {
    const plan = resolveLangPlan('zh');
    expect(preferOwnLangs(plan, ['ja'])).toEqual(plan);
  });

  it('没有音轨信息时原样返回', () => {
    const plan = resolveLangPlan('auto');
    expect(preferOwnLangs(plan, [])).toEqual(plan);
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
