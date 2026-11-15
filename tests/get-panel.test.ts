import { describe, expect, it } from 'vitest';
import {
  buildGetPanelParams,
  fetchGetPanel,
  fetchPanelTranscript,
  getPanelDiagnostic,
} from '../src/core/harvest/get-panel';
import { readTranscriptParams } from '../src/core/harvest/parse/transcript';
import { installTimedTextHook } from '../src/core/harvest/intercept';

/**
 * 2026 年原生字幕面板的数据源是 `get_panel`（panelId = PAmodern_transcript_view）。
 *
 * 期望值来自一条**真实成功的请求**（用户提供的 curl）：
 *   POST https://www.youtube.com/youtubei/v1/get_panel?prettyPrint=false
 *   params = qgkPCgtIWXJSWUNTUnhkRRgB
 * 解码是 `aa 09 0f | 0a 0b HYrRYCSRxdE | 18 01` = protobuf {149: {1: videoId, 3: 1}}。
 *
 * 三条铁律（都是从真实网络面板里踩出来的）：
 *   1. URL **不带 `?key=`** —— 带 key 的请求全红，不带 key 的原生请求才成功；
 *   2. 一律用页面自己的 INNERTUBE_CONTEXT（clientName 1 + 页面 clientVersion +
 *      visitorData + SAPISIDHASH），不遍历 ANDROID / TVHTML5 / 编码变体；
 *   3. **只发一次**，params 一律自拼。页面 `getTranscriptEndpoint.params` 是给
 *      「可搜索字幕面板」用的，问 `get_panel` 只会返回 960 字节的空面板
 *      —— 先试它再试自拼的，就是用户看到的「两次请求，一次空一次满」。
 */

const REAL_PARAMS = 'qgkPCgtIWXJSWUNTUnhkRRgB';
const REAL_VIDEO = 'HYrRYCSRxdE';
const PANEL_URL = 'https://www.youtube.com/youtubei/v1/get_panel?prettyPrint=false';

const SEGMENTS = JSON.stringify({
  content: {
    engagementPanelSectionListRenderer: {
      content: {
        sectionListRenderer: {
          contents: [
            {
              itemSectionRenderer: {
                contents: [
                  {
                    macroMarkersPanelItemViewModel: {
                      item: {
                        timelineItemViewModel: {
                          timestamp: '0:03',
                          contentItems: [
                            {
                              transcriptSegmentViewModel: {
                                simpleText: 'first',
                                timestamp: '0:03',
                              },
                            },
                          ],
                        },
                      },
                    },
                  },
                  {
                    macroMarkersPanelItemViewModel: {
                      item: {
                        timelineItemViewModel: {
                          timestamp: '0:13',
                          contentItems: [
                            {
                              transcriptSegmentViewModel: {
                                simpleText: 'second',
                                timestamp: '0:13',
                              },
                            },
                          ],
                        },
                      },
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    },
  },
});

const PAGE_CONTEXT = {
  client: {
    clientName: 'WEB',
    clientVersion: '2.20261112.10.00',
    visitorData: 'VISITOR-123',
    hl: 'en',
    gl: 'US',
  },
};

/** 页面自带的 params：给「可搜索字幕面板」用的，问 get_panel 只会得到空面板。 */
const PAGE_PARAMS =
  'CgtIWXJSWUNTUnhkRRISQ2dOaGMzSVNBbVZ1R2dBJTNEGAEqM2VuZ2FnZW1lbnQtcGFuZWwtc2VhcmNoYWJsZS10cmFuc2NyaXB0LXNlYXJjaC1wYW5lbDABOAFAAQ%3D%3D';

function winWithPage(): Window {
  return {
    ytcfg: {
      data_: () => ({ INNERTUBE_CONTEXT: PAGE_CONTEXT }),
      get_: () => undefined,
    },
    ytInitialData: { engagementPanels: [{ getTranscriptEndpoint: { params: PAGE_PARAMS } }] },
    location: { href: `https://www.youtube.com/watch?v=${REAL_VIDEO}` },
  } as unknown as Window;
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe('buildGetPanelParams：与真实请求逐字一致', () => {
  it('编码出的 params 就是 YouTube 自己发的那一个', () => {
    expect(buildGetPanelParams(REAL_VIDEO)).toBe(REAL_PARAMS);
  });

  it('从 params 里能读回 videoId（hook 靠它判断响应属于哪个视频）', () => {
    const body = JSON.stringify({ panelId: 'PAmodern_transcript_view', params: REAL_PARAMS });
    expect(readTranscriptParams(body).videoId).toBe(REAL_VIDEO);
  });
});

describe('hook 认得 get_panel', () => {
  function makeWin(text: string, status = 200) {
    return {
      fetch: (async () => new Response(text, { status })) as unknown as typeof fetch,
      location: { href: `https://www.youtube.com/watch?v=${REAL_VIDEO}` },
    } as unknown as Window;
  }

  it('字幕面板的 get_panel 响应会被截获', async () => {
    const win = makeWin('{"segments":[]}');
    const hook = installTimedTextHook(win);

    await win.fetch(PANEL_URL, {
      method: 'POST',
      body: JSON.stringify({ panelId: 'PAmodern_transcript_view', params: REAL_PARAMS }),
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const captures = hook.captures();
    expect(captures).toHaveLength(1);
    expect(captures[0].kind).toBe('get_panel');
    expect(captures[0].videoId).toBe(REAL_VIDEO);
  });

  it('别的面板（评论之类）不截', async () => {
    const win = makeWin('{"comments":[]}');
    const hook = installTimedTextHook(win);

    await win.fetch(PANEL_URL, {
      method: 'POST',
      body: JSON.stringify({ panelId: 'engagement-panel-comments-section' }),
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(hook.captures()).toHaveLength(0);
  });
});

describe('fetchGetPanel：只发一次，形状照抄原生', () => {
  it('URL 不带 key；body 带 panelId + 自拼 params；页面上下文原样转发', async () => {
    const seen: { url: string; body: string; headers: Record<string, string> }[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seen.push({
        url: String(url),
        body: String(init?.body),
        headers: init?.headers as Record<string, string>,
      });
      return new Response(SEGMENTS, { status: 200 });
    }) as unknown as typeof fetch;

    const outcome = await fetchGetPanel({
      win: winWithPage(),
      fetchFn,
      videoId: REAL_VIDEO,
      signal: signal(),
      timeoutMs: 3_000,
    });

    expect(outcome?.lines.map((line) => line.text)).toEqual(['first', 'second']);
    // 2026 面板没有 startMs，只有 "0:03"，能解析出时间才算真的成了
    expect(outcome?.lines[0]).toMatchObject({ start: 3000, dur: 10000 });

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(PANEL_URL);
    expect(seen[0].url).not.toContain('key=');

    const body = JSON.parse(seen[0].body) as { context: unknown; panelId: string; params: string };
    expect(body.panelId).toBe('PAmodern_transcript_view');
    expect(body.params).toBe(REAL_PARAMS);
    expect(body.context).toEqual(PAGE_CONTEXT);

    expect(seen[0].headers['X-Youtube-Client-Name']).toBe('1');
    expect(seen[0].headers['X-Youtube-Client-Version']).toBe('2.20261112.10.00');
    expect(seen[0].headers['X-Goog-Visitor-Id']).toBe('VISITOR-123');
  });

  it('页面自带的 getTranscriptEndpoint.params 不参与请求（它只会返回空面板）', async () => {
    const bodies: string[] = [];
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(SEGMENTS, { status: 200 });
    }) as unknown as typeof fetch;

    await fetchGetPanel({
      win: winWithPage(),
      fetchFn,
      videoId: REAL_VIDEO,
      signal: signal(),
      timeoutMs: 3_000,
    });

    // 只有一次，而且用的不是页面那份 params
    expect(bodies).toHaveLength(1);
    const params = (JSON.parse(bodies[0]) as { params: string }).params;
    expect(params).toBe(REAL_PARAMS);
    expect(params).not.toBe(PAGE_PARAMS);
  });

  it('语言取自 defaultAudioLanguage（面板就是默认轨），且不看 captionTracks[0]', async () => {
    const fetchFn = (async () => new Response(SEGMENTS, { status: 200 })) as unknown as typeof fetch;
    const withMeta = {
      ...winWithPage(),
      ytInitialPlayerResponse: {
        // 多轨视频第一条未必是默认轨（实测 uxdh2lqc-1Y 第一条是 ar，面板给的是 en）
        captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'ar' }] } },
        videoDetails: { defaultAudioLanguage: 'en' },
      },
    } as unknown as Window;

    const hit = await fetchGetPanel({
      win: withMeta,
      fetchFn,
      videoId: REAL_VIDEO,
      signal: signal(),
      timeoutMs: 3_000,
    });
    expect(hit?.lang).toBe('en');

    const miss = await fetchGetPanel({
      win: winWithPage(),
      fetchFn,
      videoId: REAL_VIDEO,
      signal: signal(),
      timeoutMs: 3_000,
    });
    // 不编造：推不出来就是 null（上层据此决定要不要走翻译）
    expect(miss?.lang).toBeNull();
  });

  it('HTTP 400 时不重试（同一个请求再来一遍没有意义）', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return new Response('{"error":{"code":400,"message":"Precondition check failed"}}', {
        status: 400,
      });
    }) as unknown as typeof fetch;

    const outcome = await fetchGetPanel({
      win: winWithPage(),
      fetchFn,
      videoId: REAL_VIDEO,
      signal: signal(),
      timeoutMs: 3_000,
    });

    expect(outcome).toBeNull();
    expect(calls).toBe(1);
    expect(getPanelDiagnostic()).toContain('HTTP 400');
  });

  it('200 但 0 段：返回 null，诊断写明字节数，并把响应头打到 console', async () => {
    const fetchFn = (async () =>
      new Response('{"responseContext":{},"trackingParams":"x"}', { status: 200 })) as unknown as typeof fetch;

    const outcome = await fetchGetPanel({
      win: winWithPage(),
      fetchFn,
      videoId: REAL_VIDEO,
      signal: signal(),
      timeoutMs: 3_000,
    });

    expect(outcome).toBeNull();
    expect(getPanelDiagnostic()).toContain('200 但 0 段');
    expect(getPanelDiagnostic()).toContain('字节');
  });
});

describe('登录态：Authorization: SAPISIDHASH', () => {
  function winWithCookie(cookie: string) {
    return { document: { cookie } } as unknown as Window;
  }

  it('带上 SAPISIDHASH，且摘要就是「时间戳 + SAPISID + origin」的 SHA-1', async () => {
    const sent: Record<string, string>[] = [];
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      sent.push(init?.headers as Record<string, string>);
      return new Response(SEGMENTS, { status: 200 });
    }) as unknown as typeof fetch;

    const outcome = await fetchGetPanel({
      win: winWithCookie('OTHER=1; SAPISID=TESTCOOKIE; FOO=2'),
      fetchFn,
      videoId: REAL_VIDEO,
      signal: signal(),
      timeoutMs: 3_000,
    });

    expect(outcome?.lines[0]?.text).toBe('first');

    const auth = sent[0].Authorization;
    const match = /^SAPISIDHASH (\d+)_([0-9a-f]{40})$/u.exec(auth);
    expect(match).not.toBeNull();

    // 摘要按公式独立算一遍再比对
    const [, timestamp, digest] = match!;
    const expected = [
      ...new Uint8Array(
        await crypto.subtle.digest(
          'SHA-1',
          new TextEncoder().encode(`${timestamp} TESTCOOKIE https://www.youtube.com`),
        ),
      ),
    ]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    expect(digest).toBe(expected);

    expect(sent[0]['X-Youtube-Bootstrap-Logged-In']).toBe('true');
    expect(sent[0]['X-Goog-AuthUser']).toBe('0');
  });

  it('三个变体都带上（SAPISID / 1P / 3P）', async () => {
    const sent: Record<string, string>[] = [];
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      sent.push(init?.headers as Record<string, string>);
      return new Response(SEGMENTS, { status: 200 });
    }) as unknown as typeof fetch;

    await fetchGetPanel({
      win: winWithCookie('SAPISID=A; __Secure-1PAPISID=B; __Secure-3PAPISID=C'),
      fetchFn,
      videoId: REAL_VIDEO,
      signal: signal(),
      timeoutMs: 3_000,
    });

    expect(sent[0].Authorization).toMatch(
      /^SAPISIDHASH \d+_[0-9a-f]{40} SAPISID1PHASH \d+_[0-9a-f]{40} SAPISID3PHASH \d+_[0-9a-f]{40}$/u,
    );
  });

  it('没登录（拿不到 cookie）时退回匿名请求，不硬塞空头', async () => {
    const sent: Record<string, string>[] = [];
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      sent.push(init?.headers as Record<string, string>);
      return new Response(SEGMENTS, { status: 200 });
    }) as unknown as typeof fetch;

    await fetchGetPanel({
      win: {} as Window,
      fetchFn,
      videoId: REAL_VIDEO,
      signal: signal(),
      timeoutMs: 3_000,
    });

    expect(sent[0].Authorization).toBeUndefined();
  });
});

describe('fetchPanelTranscript：只有 get_panel 一条路', () => {
  it('200 但解析不出分段时抛 EMPTY_200（不是网络异常）', async () => {
    const fetchFn = (async () =>
      new Response('{"actions":[{"updateEngagementPanelAction":{}}]}', { status: 200 })) as unknown as typeof fetch;

    await expect(
      fetchPanelTranscript({
        win: winWithPage(),
        fetchFn,
        videoId: REAL_VIDEO,
        signal: signal(),
        timeoutMs: 3_000,
      }),
    ).rejects.toMatchObject({
      code: 'EMPTY_200',
      message: expect.stringContaining('200 但 0 段'),
    });
  });

  it('失败时抛出带诊断的错误，且只打了 get_panel', async () => {
    const seen: string[] = [];
    const fetchFn = (async (url: string) => {
      seen.push(String(url));
      return new Response('{"error":{"code":400,"message":"Precondition check failed"}}', {
        status: 400,
      });
    }) as unknown as typeof fetch;

    await expect(
      fetchPanelTranscript({
        win: winWithPage(),
        fetchFn,
        videoId: REAL_VIDEO,
        signal: signal(),
        timeoutMs: 3_000,
      }),
    ).rejects.toThrow(/get_panel 失败[\s\S]*HTTP 400/u);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('/youtubei/v1/get_panel');
  });
});
