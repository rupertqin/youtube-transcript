import { describe, expect, it } from 'vitest';
import type { TimedTextCapture, TimedTextHook } from '../src/core/harvest/intercept';
import { runInterceptSource } from '../src/core/harvest/sources';
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

  it('语言码读不到时照样放行 —— 完整响应比 DOM 一屏重要', async () => {
    const outcome = await runInterceptSource(
      {
        videoId: VIDEO_ID,
        langs: ['zh-Hans'],
        tlang: 'zh-Hans',
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
  });
});
