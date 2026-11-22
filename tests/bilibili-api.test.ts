import { describe, expect, it } from 'vitest';
import { createBiliApi } from '../src/core/site/bilibili/api';
import { parseSubtitleBody } from '../src/core/site/bilibili/parse';

/**
 * B 站接口层端到端（假 fetch）。
 *
 * 验证的是整条签名链真的能串起来：view → nav（未登录也取 key）→
 * wbi 签名的 player 接口 → 字幕 CDN → 行解析，以及错误码映射。
 */
const log = (() => undefined) as unknown as Parameters<typeof createBiliApi>[0]['log'];
const win = {} as Window;

function fakeFetch(overrides: Record<string, unknown> = {}): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    let data: unknown;
    if (url.includes('/x/web-interface/view')) {
      data = {
        code: 0,
        data: {
          bvid: 'BV1xx411c7mD',
          title: '测试视频',
          duration: 120,
          pages: [
            { cid: 100, page: 1 },
            { cid: 222, page: 2 },
          ],
        },
      };
    } else if (url.includes('/x/web-interface/nav')) {
      // 未登录时 code=-101，但 wbi_img 依然可用
      data = {
        code: -101,
        message: '账号未登录',
        data: {
          wbi_img: {
            img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
            sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70acbd.png',
          },
        },
      };
    } else if (url.includes('/x/player/wbi/v2')) {
      Object.assign(overrides, { playerUrl: url });
      data = {
        code: 0,
        data: {
          subtitle: {
            subtitles: [{ lan: 'ai-zh', type: 1, subtitle_url: '//aisubtitle.hdslb.com/sub.json' }],
          },
        },
      };
    } else if (url.includes('aisubtitle.hdslb.com')) {
      data = { body: [{ from: 0, to: 1.5, content: '你好' }] };
    } else {
      throw new Error(`unexpected url: ${url}`);
    }
    return { ok: true, json: async () => data } as Response;
  }) as typeof fetch;
}

describe('B 站接口客户端', () => {
  it('未登录也取得到 WBI key，player 请求带 w_rid / wts / cid', async () => {
    const overrides: Record<string, unknown> = {};
    const api = createBiliApi({ win, log, fetchFn: fakeFetch(overrides) });

    const view = await api.view('BV1xx411c7mD', new AbortController().signal);
    expect(view.pages.find((page) => page.page === 2)?.cid).toBe(222);

    const tracks = await api.tracks(view.bvid, 222, new AbortController().signal);
    expect(tracks).toHaveLength(1);
    const playerUrl = String(overrides.playerUrl);
    expect(playerUrl).toContain('cid=222');
    expect(playerUrl).toMatch(/wts=\d+/u);
    expect(playerUrl).toMatch(/w_rid=[0-9a-f]{32}/u);

    const raw = await api.subtitle(tracks[0].subtitle_url!, new AbortController().signal);
    expect(parseSubtitleBody(raw)).toEqual([{ start: 0, dur: 1_500, text: '你好' }]);
  });

  it('-352 映射成 RATE_LIMITED，detail 提示风控', async () => {
    const api = createBiliApi({
      win,
      log,
      fetchFn: (async () =>
        ({ ok: true, json: async () => ({ code: -352, message: '风控' }) }) as Response) as typeof fetch,
    });
    await expect(api.view('BV1xx411c7mD', new AbortController().signal)).rejects.toMatchObject({
      name: 'BiliApiError',
      code: 'RATE_LIMITED',
    });
  });

  it('字幕 CDN 带 cookie 失败时退回无凭证请求', async () => {
    let attempt = 0;
    const api = createBiliApi({
      win,
      log,
      fetchFn: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        attempt += 1;
        if (attempt === 1) {
          expect(init?.credentials).toBe('include');
          return { ok: false, status: 403 } as Response;
        }
        expect(init?.credentials).toBe('omit');
        return { ok: true, json: async () => ({ body: [] }) } as Response;
      }) as typeof fetch,
    });
    await expect(api.subtitle('https://aisubtitle.hdslb.com/sub.json', new AbortController().signal)).resolves.toEqual({
      body: [],
    });
    expect(attempt).toBe(2);
  });
});
