import { describe, expect, it, vi } from 'vitest';
import { createSession } from '../src/platform/session';
import { createFakeSite } from './fake-site';

/**
 * 切页自愈。
 *
 * 用户看到的症状是「整个面板（含标题）停在旧视频」——这只能是**状态压根没换**，
 * 而不是抓到了旧字幕。所以这里测的是「谁驱动状态」这一层：
 *   1. 地址栏变了，调用一次 sync 就必须把 store 切到新视频；
 *   2. 没有任何事件时，start() 的 500ms 对账也必须自己切过去。
 */

interface FakeWin {
  win: Window;
  setId(id: string): void;
  intervals: number[];
}

function makeWin(initialId: string): FakeWin {
  let current = initialId;
  const intervals: number[] = [];

  const player = {
    getVideoData: () => ({ video_id: current }),
    getPlayerResponse: () => ({ videoDetails: { videoId: current, title: `title-${current}` } }),
  };

  const doc = {
    title: `title-${initialId} - YouTube`,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    querySelector: (selector: string) => (selector === '#movie_player' ? player : null),
    querySelectorAll: () => [],
  };

  const win = {
    document: doc,
    location: {
      get href() {
        return `https://www.youtube.com/watch?v=${current}`;
      },
    },
    // 委托给全局实现：测试里用 vi.useFakeTimers() 接管的就是它
    setInterval: ((fn: () => void, ms: number) => {
      intervals.push(ms);
      return globalThis.setInterval(fn, ms);
    }) as unknown as typeof setInterval,
    clearInterval: ((id: number) => globalThis.clearInterval(id)) as unknown as typeof clearInterval,
    setTimeout: ((fn: () => void) => 0) as unknown as typeof setTimeout,
    clearTimeout: (() => undefined) as unknown as typeof clearTimeout,
  } as unknown as Window;

  return {
    win,
    setId(id: string) {
      current = id;
    },
    intervals,
  };
}

const site = createFakeSite();

describe('session 对账（reconcile）', () => {
  it('地址栏换视频后，一次 sync 就把状态切过去（不依赖抓取完成）', () => {
    const fake = makeWin('AAAAAAAAAAA');
    const session = createSession({ win: fake.win, site });

    session.sync();
    expect(session.store.getState().videoId).toBe('AAAAAAAAAAA');

    fake.setId('BBBBBBBBBBB');
    session.sync();

    const state = session.store.getState();
    expect(state.videoId).toBe('BBBBBBBBBBB');
    // 先清空再抓：绝不能让旧视频的行留在界面上
    expect(state.lines).toEqual([]);
    expect(state.status).toBe('loading');
    expect(state.title).toBe('title-BBBBBBBBBBB');

    session.dispose();
  });

  it('同一个视频重复 sync 是幂等的，不会反复清空', () => {
    const fake = makeWin('AAAAAAAAAAA');
    const session = createSession({ win: fake.win, site });

    session.sync();
    session.store.setState({ status: 'ready' });
    session.sync();

    expect(session.store.getState().status).toBe('ready');
    session.dispose();
  });

  it('离开观看页（没有 ?v=）时清空状态', () => {
    const fake = makeWin('AAAAAAAAAAA');
    const session = createSession({ win: fake.win, site });
    session.sync();

    // 模拟跳去首页
    Object.defineProperty(fake.win, 'location', { value: { href: 'https://www.youtube.com/' } });
    session.sync();

    expect(session.store.getState().videoId).toBe('');
    expect(session.store.getState().status).toBe('idle');

    session.dispose();
  });
});

describe('session.start 定时自愈', () => {
  it('用 500ms 间隔起一个对账循环，且重复 start 不会叠加定时器', () => {
    const fake = makeWin('AAAAAAAAAAA');
    const session = createSession({ win: fake.win, site });

    session.start();
    session.start();

    expect(fake.intervals).toEqual([500]);
    session.dispose();
  });

  it('即使没有任何事件，定时对账也能发现切页', () => {
    vi.useFakeTimers();
    try {
      const fake = makeWin('AAAAAAAAAAA');
      const session = createSession({ win: fake.win, site });

      // start 会立刻对账一次
      session.start();
      expect(session.store.getState().videoId).toBe('AAAAAAAAAAA');

      // 用户点击相关视频：地址栏变了，但**不触发任何回调**
      fake.setId('CCCCCCCCCCC');
      vi.advanceTimersByTime(600);

      expect(session.store.getState().videoId).toBe('CCCCCCCCCCC');
      session.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
