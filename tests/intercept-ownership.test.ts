import { describe, expect, it, vi } from 'vitest';
import { installTimedTextHook } from '../src/core/harvest/intercept';

/**
 * 归属判定必须用「请求发出那一刻」的地址栏。
 *
 * 真实时序：用户还停在视频 A，YouTube 为 A 发出 get_transcript；
 * 用户切到视频 B 之后响应才到。若在响应回调里读 location，
 * 这条 A 的响应就会被标成 B，切页后直接显示上一个视频的字幕。
 */

function fakeWindow(href: string) {
  class FakeXHR {
    open(): void {}
    send(): void {}
  }
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const win = {
    location: { href },
    XMLHttpRequest: FakeXHR,
    fetch: async () => {
      await gate;
      return { clone: () => ({ text: async () => '{"actions":[]}' }) };
    },
  } as unknown as Window & { location: { href: string } };
  return { win, release: () => release?.() };
}

describe('get_transcript 归属以发起请求时的地址栏为准', () => {
  it('响应到达前地址栏切走，仍归属原视频，且不命中新视频', async () => {
    const { win, release } = fakeWindow('https://www.youtube.com/watch?v=AAAAAAAAAAA');
    const hook = installTimedTextHook(win);

    const pending = win.fetch('https://www.youtube.com/youtubei/v1/get_transcript?key=abc', {
      method: 'POST',
      body: '{"context":{},"params":"abc"}',
    });

    // 响应还没回来，用户已经切到 B
    win.location.href = 'https://www.youtube.com/watch?v=BBBBBBBBBBB';

    release();
    await pending;

    await vi.waitFor(() => expect(hook.captures()).toHaveLength(1));
    const [capture] = hook.captures();
    expect(capture.videoId).toBe('AAAAAAAAAAA');

    // 关键：这条 A 的响应不能被当成 B 的字幕
    expect(hook.latest('BBBBBBBBBBB')).toBeNull();
    expect(await hook.waitFor('BBBBBBBBBBB', 0)).toBeNull();
    expect(hook.latest('AAAAAAAAAAA')).toBeTruthy();
  });

  it('timedtext 的归属仍从 URL 取，不受地址栏影响', async () => {
    const { win, release } = fakeWindow('https://www.youtube.com/watch?v=AAAAAAAAAAA');
    const hook = installTimedTextHook(win);

    const pending = win.fetch('https://www.youtube.com/api/timedtext?v=CCCCCCCCCCC&lang=zh');
    win.location.href = 'https://www.youtube.com/watch?v=BBBBBBBBBBB';
    release();
    await pending;

    await vi.waitFor(() => expect(hook.captures()).toHaveLength(1));
    expect(hook.captures()[0].videoId).toBe('CCCCCCCCCCC');
  });
});
