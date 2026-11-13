import { describe, expect, it, vi } from 'vitest';
import { harvestTranscript } from '../src/core/harvest/chain';
import type { TimedTextHook } from '../src/core/harvest/intercept';
import { hasNativeTrackFor, readAvailableLangs } from '../src/core/harvest/player';
import { runInterceptSource } from '../src/core/harvest/sources';
import type { SourceOutcome } from '../src/core/types';

/**
 * 「切到 English 再切回中文就失败」的回归。
 *
 * 原因：拦截层（原生面板发出的 get_transcript / timedtext 捕获）只认视频原文。
 * 它排在兜底链最前面，一旦命中就直接返回，于是选了中文也只会拿到英文 ——
 * 而且状态是 ready，界面上完全看不出「没翻译」和「抓到了」的区别。
 *
 * 两条防线：
 *   ① 有 tlang 而捕获语言不符 → 拦截层主动放弃；
 *   ② 视频没有目标语言的原生轨道时，远程层排到最前面（它是唯一能翻译的）。
 */

const JSON3 = JSON.stringify({
  events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hello' }] }],
});

const line = (text: string) => ({ start: 0, dur: 1000, text });

const fakeHook = (lang: string | null): TimedTextHook =>
  ({
    installedAt: 0,
    captures: () => [],
    latest: () => null,
    onCapture: () => () => undefined,
    dispose: () => undefined,
    waitFor: async () => ({
      url: 'https://www.youtube.com/api/timedtext?v=AAAAAAAAAAA&lang=en',
      kind: 'timedtext',
      videoId: 'AAAAAAAAAAA',
      lang,
      text: JSON3,
      at: Date.now(),
    }),
  }) as unknown as TimedTextHook;

const ctx = (tlang: string | null) => ({
  videoId: 'AAAAAAAAAAA',
  langs: ['zh-Hans', 'zh', 'en'],
  tlang,
  signal: new AbortController().signal,
  log: () => undefined,
});

describe('拦截层不能顶替翻译结果', () => {
  it('要中文但捕获的是英文 → 放弃，交给后面的层', async () => {
    const outcome = await runInterceptSource(ctx('zh-Hans'), fakeHook('en'), 0);
    expect(outcome?.lines).toEqual([]);
    expect(outcome?.failures?.[0]?.detail).toContain('不是要的 zh-Hans');
  });

  it('捕获语言与目标一致时正常返回', async () => {
    const outcome = await runInterceptSource(ctx('zh-Hans'), fakeHook('zh-Hans'), 0);
    expect(outcome?.lines.length).toBe(1);
  });

  it('同音频模式（无 tlang）不做语言过滤', async () => {
    const outcome = await runInterceptSource(ctx(null), fakeHook('en'), 0);
    expect(outcome?.lines.length).toBe(1);
  });
});

describe('preferRemote：要翻译时远程优先', () => {
  const deps = (preferRemote: boolean) => {
    const calls: string[] = [];
    const outcome = (source: SourceOutcome['source'], text: string): SourceOutcome => ({
      lines: [line(text)],
      source,
      showTimestamps: true,
    });
    return {
      calls,
      deps: {
        signal: new AbortController().signal,
        log: () => undefined,
        preferRemote,
        cachedIntercept: async (): Promise<SourceOutcome | null> => {
          calls.push('cachedIntercept');
          return outcome('intercept', 'english from capture');
        },
        structured: async (): Promise<SourceOutcome | null> => {
          calls.push('structured');
          return null;
        },
        domPreview: () => {
          calls.push('domPreview');
          return { ...outcome('dom', 'english from dom'), complete: false };
        },
        remote: async (): Promise<SourceOutcome | null> => {
          calls.push('remote');
          return outcome('player', 'translated to chinese');
        },
      },
    };
  };

  it('开了 preferRemote 就直接问远程，不再被拦截层抢答', async () => {
    const { calls, deps: d } = deps(true);
    const result = await harvestTranscript(d);

    expect(calls).toEqual(['remote']);
    expect(result.lines[0].text).toBe('translated to chinese');
  });

  it('默认顺序仍然是拦截层先命中（同音频不受影响）', async () => {
    const { calls, deps: d } = deps(false);
    const result = await harvestTranscript(d);

    expect(calls).toEqual(['cachedIntercept']);
    expect(result.lines[0].text).toBe('english from capture');
  });

  it('远程失败时仍回落到原文，拿原文总比什么都没有强', async () => {
    const { calls, deps: d } = deps(true);
    d.remote = async () => {
      calls.push('remote');
      return null;
    };
    const result = await harvestTranscript(d);

    // 远程排第一，但失败后照常往下走（拦截层比 DOM 便宜，先试它）
    expect(calls[0]).toBe('remote');
    expect(calls.length).toBeGreaterThan(1);
    expect(result.lines[0].text).toContain('english');
  });
});

describe('hasNativeTrackFor', () => {
  const win = (languages: string[]): Window =>
    ({
      document: {
        querySelector: (selector: string) =>
          selector === '#movie_player'
            ? {
                getPlayerResponse: () => ({
                  videoDetails: { videoId: 'A' },
                  captions: {
                    playerCaptionsTracklistRenderer: {
                      captionTracks: languages.map((languageCode) => ({
                        baseUrl: `https://x/?lang=${languageCode}`,
                        languageCode,
                        kind: 'asr',
                      })),
                    },
                  },
                }),
              }
            : null,
      },
    }) as unknown as Window;

  it('视频自带中文轨道时，不需要为了语言绕开 DOM/拦截层', () => {
    expect(hasNativeTrackFor(win(['zh-Hans', 'en']), 'zh-Hans')).toBe(true);
  });

  it('只有英文轨道时，选中文必须走能翻译的远程层', () => {
    expect(hasNativeTrackFor(win(['en']), 'zh-Hans')).toBe(false);
  });

  it('繁体也算中文', () => {
    expect(hasNativeTrackFor(win(['zh-Hant']), 'zh-Hans')).toBe(true);
  });
});

describe('readAvailableLangs：按钮只在有字幕时出现', () => {
  const win = (payload: unknown): Window =>
    ({
      document: {
        querySelector: (selector: string) =>
          selector === '#movie_player' ? { getPlayerResponse: () => payload } : null,
      },
    }) as unknown as Window;

  const response = (tracks: string[], translations: string[], videoId = 'A') => ({
    videoDetails: { videoId },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: tracks.map((languageCode) => ({
          baseUrl: `https://x/?lang=${languageCode}`,
          languageCode,
        })),
        translationLanguages: translations.map((languageCode) => ({ languageCode })),
      },
    },
  });

  it('只认原生轨道：声称能机翻的语言不算（否则按钮可点却拿不到字幕）', () => {
    const langs = readAvailableLangs(win(response(['en'], ['zh-Hans', 'ja', 'en'])));
    expect(langs).toEqual(['en']);
    expect(langs).not.toContain('zh-hans');
  });

  it('原生中文轨道存在时可点', () => {
    expect(readAvailableLangs(win(response(['zh-Hans', 'en'], [])))).toEqual(['zh-hans', 'en']);
  });

  it('没有任何字幕时不报任何语言（也就不会显示语言按钮）', () => {
    expect(readAvailableLangs(win({ videoDetails: { videoId: 'A' } }))).toEqual([]);
    expect(readAvailableLangs(win(null))).toEqual([]);
  });

  it('播放器响应还属于上一个视频时不采信', () => {
    expect(readAvailableLangs(win(response(['en'], ['zh-Hans'], 'OLD')), 'NEW')).toEqual([]);
  });

  it('归属一致时正常返回', () => {
    const langs = readAvailableLangs(win(response(['en'], ['zh-Hans'], 'NEW')), 'NEW');
    expect(langs).toContain('en');
  });
});

describe('langFromTimedTextUrl 取产出语言', () => {
  it('带 tlang 时以 tlang 为准，而不是源轨道语言', async () => {
    const { langFromTimedTextUrl } = await import('../src/core/harvest/timedtext');
    expect(langFromTimedTextUrl('https://x/?lang=en&tlang=zh-Hans')).toBe('zh-Hans');
    expect(langFromTimedTextUrl('https://x/?lang=en')).toBe('en');
  });
});

// 保持 vi 引用，避免未使用告警（部分断言依赖 mock 能力）
void vi;
