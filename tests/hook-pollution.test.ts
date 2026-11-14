import { describe, expect, it } from 'vitest';
import { installTimedTextHook, SELF_FETCH } from '../src/core/harvest/intercept';

/**
 * 真实缺陷（诊断里的 `截到了 get_transcript 响应（119 字符）但解析出 0 行` + `0ms`）：
 *
 * hook 补的是全局 `window.fetch`，所以我们自己直连 `get_transcript` 的请求
 * **也会被截下来**。失败时截到的是 119 字符的 400 错误体，它把捕获缓存污染成
 * 「已有一条 get_transcript 响应」—— 拦截层 0ms 命中垃圾、解析出 0 行，
 * 真正的面板响应反而等不到，于是只能退到 DOM 读虚拟列表那一屏。
 */

const URL = 'https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false';
const BODY = JSON.stringify({ params: 'AAAA' });

function makeWin(responses: { status: number; text: string }[]) {
  const queue = [...responses];
  const calls: { url: string; init?: RequestInit }[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = queue.shift() ?? { status: 200, text: '' };
    return new Response(next.text, { status: next.status });
  }) as unknown as typeof fetch;

  const win = {
    fetch: fakeFetch,
    location: { href: 'https://www.youtube.com/watch?v=AAAAAAAAAAA' },
  } as unknown as Window & typeof globalThis;

  return { win, calls };
}

describe('hook 不再被我们自己的请求污染', () => {
  it('打了 SELF_FETCH 标记的请求不进捕获缓存', async () => {
    const { win } = makeWin([{ status: 200, text: BODY }]);
    const hook = installTimedTextHook(win);

    const init: RequestInit & Record<symbol, unknown> = { method: 'POST', body: BODY };
    init[SELF_FETCH] = true;
    await win.fetch(URL, init);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(hook.captures()).toHaveLength(0);
  });

  it('错误响应（400 那种 119 字符错误体）不进捕获缓存', async () => {
    const { win } = makeWin([
      {
        status: 400,
        text: '{"error":{"code":400,"message":"Precondition check failed"}}',
      },
    ]);
    const hook = installTimedTextHook(win);

    await win.fetch(URL, { method: 'POST', body: BODY });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(hook.captures()).toHaveLength(0);
  });

  it('真正成功的字幕响应照常截获', async () => {
    const { win } = makeWin([{ status: 200, text: BODY }]);
    const hook = installTimedTextHook(win);

    await win.fetch(URL, { method: 'POST', body: BODY });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const captures = hook.captures();
    expect(captures).toHaveLength(1);
    expect(captures[0].kind).toBe('get_transcript');
    expect(captures[0].text).toBe(BODY);
    // 归属是「请求发出那一刻」的地址栏视频
    expect(captures[0].videoId).toBe('AAAAAAAAAAA');
  });
});
