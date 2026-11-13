import { describe, expect, it } from 'vitest';
import { installTimedTextHook } from '../src/core/harvest/intercept';
import { videoIdFromGetTranscriptBody } from '../src/core/harvest/parse/transcript';

/**
 * 「点击跳转页面后，字幕还是上一条视频的」。
 *
 * 病根在 get_transcript 的归属：
 *   - 这个接口 URL 上只有 prettyPrint，真实 videoId 在 POST body 的 base64(protobuf) params 里；
 *   - 之前的正则找的是字面量 `"videoId"`，真实 body 里根本没有 → 永远返回 null；
 *   - 于是退回「发请求那一刻的地址栏」，而 SPA 切页时地址栏先变、面板后变，
 *     旧面板迟到的请求就被错标成新视频 → 新视频显示的正是上一条的字幕，
 *     而且 videoId 完全对得上，诊断面板查不出任何异常。
 *
 * 两道修正：从 params 里解出 videoId；解不出时用**播放器** id 而不是地址栏。
 */

/** protobuf: field 1 (0x0a) + len 0x0b + 11 字节 id */
function paramsFor(videoId: string): string {
  return btoa(`\u000a\u000b${videoId}`);
}

describe('videoIdFromGetTranscriptBody', () => {
  it('从 base64 params 里解出 videoId（真实 body 的形状）', () => {
    const body = JSON.stringify({
      context: { client: { clientName: 'WEB', clientVersion: '2.20260101.00.00' } },
      params: paramsFor('dQw4w9WgXcQ'),
    });
    expect(videoIdFromGetTranscriptBody(body)).toBe('dQw4w9WgXcQ');
  });

  it('body 里直接带 videoId 时优先用它', () => {
    expect(videoIdFromGetTranscriptBody('{"videoId":"AAAAAAAAAAA","params":"xx"}')).toBe(
      'AAAAAAAAAAA',
    );
  });

  it('解不出来时返回 null，交给上层兜底', () => {
    expect(videoIdFromGetTranscriptBody('{"params":"not-base64!!"}')).toBeNull();
    expect(videoIdFromGetTranscriptBody('')).toBeNull();
    expect(videoIdFromGetTranscriptBody(undefined)).toBeNull();
  });
});

describe('拦截 hook 的归属', () => {
  const makeWin = (playerId: string, urlId: string) => {
    const player = {
      getVideoData: () => ({ video_id: playerId }),
      getPlayerResponse: () => ({ videoDetails: { videoId: playerId } }),
    };
    return {
      location: { href: `https://www.youtube.com/watch?v=${urlId}` },
      document: {
        querySelector: (selector: string) => (selector === '#movie_player' ? player : null),
      },
      fetch: async () => ({
        clone: () => ({ text: async () => '{"events":[]}' }),
      }),
      setTimeout,
      clearTimeout,
    } as unknown as Window;
  };

  const postTranscript = async (win: Window, videoIdInParams: string): Promise<void> => {
    await (win.fetch as typeof fetch)(
      'https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false',
      {
        method: 'POST',
        body: JSON.stringify({ params: paramsFor(videoIdInParams) }),
      } as RequestInit,
    );
    // 响应 clone 的读取是异步的
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  it('地址栏已经是新视频、但请求属于旧视频时，归属记为旧视频', async () => {
    // 地址栏 B，播放器还停在 A（切页窗口期）
    const win = makeWin('AAAAAAAAAAA', 'BBBBBBBBBBB');
    const hook = installTimedTextHook(win);

    await postTranscript(win, 'AAAAAAAAAAA');

    const capture = hook.captures()[0];
    expect(capture?.videoId).toBe('AAAAAAAAAAA');
    // 关键：这条捕获不能被新视频的 waitFor 命中
    expect(hook.latest('BBBBBBBBBBB')).toBeNull();
  });

  it('body 解不出 id 时用播放器归属，而不是地址栏', async () => {
    const win = makeWin('AAAAAAAAAAA', 'BBBBBBBBBBB');
    const hook = installTimedTextHook(win);

    await (win.fetch as typeof fetch)(
      'https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false',
      { method: 'POST', body: '{}' } as RequestInit,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hook.captures()[0]?.videoId).toBe('AAAAAAAAAAA');
  });
});
