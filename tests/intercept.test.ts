import { describe, expect, it, vi } from 'vitest';
import { installTimedTextHook } from '../src/core/harvest/intercept';

function fakeWindow() {
  class FakeXHR {
    open(): void {}
    send(): void {}
  }
  const fetchFn = vi.fn(async () => ({
    clone: () => ({ text: async () => '{"actions":[]}' }),
  }));
  const win = {
    fetch: fetchFn,
    XMLHttpRequest: FakeXHR,
    location: { href: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
  } as unknown as Window & { fetch: (...args: unknown[]) => Promise<unknown> };
  return { win, fetchFn };
}

describe('get_transcript 被动拦截', () => {
  it('POST body 没有 videoId 时，捕获仍归属当前视频并通知订阅者', async () => {
    const { win } = fakeWindow();
    const hook = installTimedTextHook(win);
    const listener = vi.fn();
    hook.onCapture(listener);

    await win.fetch('https://www.youtube.com/youtubei/v1/get_transcript?key=abc', {
      method: 'POST',
      body: '{"context":{},"params":"abc"}',
    });

    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    const capture = listener.mock.calls[0][0] as { kind: string; videoId: string | null };
    expect(capture.kind).toBe('get_transcript');
    expect(capture.videoId).toBe('dQw4w9WgXcQ');
    expect(await hook.waitFor('dQw4w9WgXcQ', 0)).toBeTruthy();
  });

  it('onCapture 可以取消订阅', async () => {
    const { win } = fakeWindow();
    const hook = installTimedTextHook(win);
    const listener = vi.fn();
    const off = hook.onCapture(listener);
    off();

    await win.fetch('https://www.youtube.com/youtubei/v1/get_transcript?key=abc', {
      method: 'POST',
      body: '{"context":{},"params":"def"}',
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(listener).not.toHaveBeenCalled();
  });
});
