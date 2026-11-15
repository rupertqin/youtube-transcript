import { describe, expect, it } from 'vitest';
import type { TimedTextCapture, TimedTextHook } from '../src/core/harvest/intercept';
import { installTimedTextHook } from '../src/core/harvest/intercept';
import { pickCapture, runInterceptSource } from '../src/core/harvest/sources';
import { buildGetPanelParams } from '../src/core/harvest/get-panel';
import {
  langFromGetTranscriptBody,
  videoIdFromGetTranscriptBody,
} from '../src/core/harvest/parse/transcript';

/**
 * 「漏前面的字幕」的真正根因：
 *
 * `get_panel` 的 URL / params 里都没有 `lang=`，所以捕获里 `capture.lang` 恒为 null；
 * 拦截层一见「用户选了目标语言」就判成「捕获的是未知语言」，把**完整响应整条丢掉**，
 * 于是永远只能退到 DOM 兜底 —— 读到虚拟列表那一屏，前面的字幕全漏。
 */

const VIDEO_ID = 'AAAAAAAAAAA';

const PAYLOAD = JSON.stringify({
  actions: [
    {
      updateEngagementPanelAction: {
        content: {
          transcriptRenderer: {
            content: {
              transcriptSearchPanelRenderer: {
                body: {
                  transcriptSegmentListRenderer: {
                    initialSegments: [
                      {
                        transcriptSegmentRenderer: {
                          startMs: '0',
                          endMs: '1500',
                          snippet: { simpleText: 'hello' },
                        },
                      },
                      {
                        transcriptSegmentRenderer: {
                          startMs: '1500',
                          endMs: '3000',
                          snippet: { simpleText: 'world' },
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    },
  ],
});

function makeHook(capture: TimedTextCapture): TimedTextHook {
  return {
    installedAt: 0,
    captures: () => [capture],
    latest: () => capture,
    waitFor: async () => capture,
    onCapture: () => () => undefined,
    dispose: () => undefined,
  } as unknown as TimedTextHook;
}

describe('get_panel 的请求体里只有 videoId，没有语言码', () => {
  it('能从 params 里读回归属视频，语言码老实返回 null', () => {
    const body = JSON.stringify({
      context: { client: { clientName: 'WEB' } },
      panelId: 'PAmodern_transcript_view',
      params: buildGetPanelParams(VIDEO_ID),
    });

    expect(videoIdFromGetTranscriptBody(body)).toBe(VIDEO_ID);
    // 不编造语言码 —— 编错了会把整条完整响应当成「语言不符」丢掉
    expect(langFromGetTranscriptBody(body)).toBe(null);
    expect(langFromGetTranscriptBody('{"params":"not-base64"}')).toBe(null);
    expect(langFromGetTranscriptBody(null)).toBe(null);
  });
});

describe('拦截层不再把完整响应当「语言不符」丢掉', () => {
  const capture: TimedTextCapture = {
    url: 'https://www.youtube.com/youtubei/v1/get_panel?prettyPrint=false',
    kind: 'get_panel',
    videoId: VIDEO_ID,
    lang: null,
    text: PAYLOAD,
    at: Date.now(),
  };

  it('语言未知的捕获：目标就是默认语言时放行（面板给的就是默认轨）', async () => {
    const outcome = await runInterceptSource(
      {
        videoId: VIDEO_ID,
        langs: ['en'],
        tlang: 'en',
        defaultLang: 'en',
        signal: new AbortController().signal,
        log: () => undefined,
      },
      makeHook(capture),
      100,
    );

    expect(outcome?.lines).toHaveLength(2);
    expect(outcome?.lines[0].text).toBe('hello');
    expect(outcome?.complete).toBe(true);
  });

  it('语言未知的捕获：目标是别的语言时不能顶（面板只会给默认轨）', async () => {
    const outcome = await runInterceptSource(
      {
        videoId: VIDEO_ID,
        langs: ['zh-Hans'],
        tlang: 'zh-Hans',
        defaultLang: 'en',
        signal: new AbortController().signal,
        log: () => undefined,
      },
      makeHook(capture),
      100,
    );

    expect(outcome?.lines).toHaveLength(0);
    expect(outcome?.failures?.[0].detail).toContain('切成目标语言');
  });

  it('语言码确定且不符时才丢弃（这才是「切成中文显示英文」的防线）', async () => {
    const wrong: TimedTextCapture = { ...capture, lang: 'en' };
    const outcome = await runInterceptSource(
      {
        videoId: VIDEO_ID,
        langs: ['zh-Hans'],
        tlang: 'zh-Hans',
        signal: new AbortController().signal,
        log: () => undefined,
      },
      makeHook(wrong),
      100,
    );

    expect(outcome?.lines).toHaveLength(0);
    expect(outcome?.failures?.[0].code).toBe('NO_CAPTION_TRACK');
    // 可执行的提示：告诉用户该去播放器里切语言
    expect(outcome?.failures?.[0].detail).toContain('切成目标语言');
  });
});

/**
 * 「先手动切一次语言」方案：捕获里可能同时躺着多条不同语言的 timedtext，
 * 必须按目标语言挑，而不是「最新一条」。
 */
describe('多语言：按语言挑捕获、按语言等待', () => {
  function capture(lang: string, at: number): TimedTextCapture {
    return {
      url: `https://www.youtube.com/api/timedtext?v=${VIDEO_ID}&lang=${lang}&kind=asr&fmt=json3`,
      kind: 'timedtext',
      videoId: VIDEO_ID,
      lang,
      text: PAYLOAD,
      at,
    };
  }

  it('指定的语言不是最新那条时，也要挑到它', () => {
    const captures = [capture('en', 200), capture('zh-Hans', 100)];
    const picked = pickCapture(captures, {
      videoId: VIDEO_ID,
      langs: ['zh-Hans', 'en'],
      tlang: 'zh-Hans',
    });
    expect(picked?.lang).toBe('zh-Hans');
  });

  it('只要原文（auto）时取最新那条', () => {
    const captures = [capture('en', 100), capture('zh-Hans', 200)];
    expect(pickCapture(captures, { videoId: VIDEO_ID, langs: ['en'], tlang: null })?.lang).toBe(
      'zh-Hans',
    );
  });

  it('语言未知的面板捕获不能顶替指定语言', () => {
    const panelCapture: TimedTextCapture = {
      url: 'https://www.youtube.com/youtubei/v1/get_panel?prettyPrint=false',
      kind: 'get_panel',
      videoId: VIDEO_ID,
      lang: null,
      text: PAYLOAD,
      at: 300,
    };
    const picked = pickCapture([panelCapture, capture('zh-Hans', 100)], {
      videoId: VIDEO_ID,
      langs: ['zh-Hans'],
      tlang: 'zh-Hans',
    });
    expect(picked?.lang).toBe('zh-Hans');
  });

  it('waitForMatch 只被目标语言唤醒（先到的英文不算）', async () => {
    const fetchFn = async () => ({
      ok: true,
      clone: () => ({ text: async () => '{"events":[{"tStartMs":0,"segs":[{"utf8":"hi"}]}]}' }),
    });
    const win = {
      fetch: fetchFn,
      XMLHttpRequest: class {
        open(): void {}
        send(): void {}
      },
      location: { href: `https://www.youtube.com/watch?v=${VIDEO_ID}` },
    } as unknown as Window;
    const hook = installTimedTextHook(win);

    await win.fetch(`https://www.youtube.com/api/timedtext?v=${VIDEO_ID}&lang=en&kind=asr&fmt=json3`);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const pending = hook.waitForMatch!(VIDEO_ID, (item) => item.lang === 'zh-Hans', 1_000);
    await win.fetch(
      `https://www.youtube.com/api/timedtext?v=${VIDEO_ID}&lang=zh-Hans&kind=asr&fmt=json3`,
    );

    const hit = await pending;
    expect(hit?.lang).toBe('zh-Hans');
  });
});
