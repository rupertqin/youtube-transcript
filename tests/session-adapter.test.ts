import { describe, expect, it } from 'vitest';
import { createSession } from '../src/platform/session';
import type { Chapter, TranscriptLine } from '../src/core/types';
import { createFakeSite } from './fake-site';

/**
 * 会话层去站点化的验收。
 *
 * 这里用的是「完全不碰 DOM」的假站点：只要 session 还能把状态、章节、语言、
 * 缓存跑通，就说明它真的只依赖 `SiteAdapter`，而不是偷偷去读 YouTube。
 */

function makeWin(id = 'AAAAAAAAAAA'): Window {
  return {
    location: { href: `https://www.youtube.com/watch?v=${id}` },
    document: {
      title: `title-${id}`,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    setInterval: (() => 0) as unknown as typeof setInterval,
    clearInterval: () => undefined,
    setTimeout: (() => 0) as unknown as typeof setTimeout,
    clearTimeout: () => undefined,
  } as unknown as Window;
}

const line: TranscriptLine = { start: 0, dur: 1_000, text: 'hello' };

describe('session 只依赖 SiteAdapter', () => {
  it('站点 id 会写进状态（UI 据此决定显示哪些能力）', async () => {
    const site = createFakeSite({ id: 'bilibili' });
    const session = createSession({ win: makeWin(), site });
    session.sync();
    expect(session.store.getState().site).toBe('bilibili');
    session.dispose();
  });

  it('章节按站点给的播放器 id 做归属校验：不是当前视频就清空', async () => {
    const chapters: Chapter[] = [{ start: 0, dur: 0, text: '开头' }];
    const site = createFakeSite({
      chapters,
      playerVideoId: () => 'OTHERVIDEO1',
      harvest: async () => ({ lines: [line], source: 'dom', showTimestamps: true, failures: [] }),
    });
    const session = createSession({ win: makeWin(), site });
    session.sync();
    await session.load();

    expect(session.store.getState().status).toBe('ready');
    // 播放器还在别的视频上：这份章节属于旧视频，不能显示
    expect(session.store.getState().chapters).toEqual([]);
    session.dispose();
  });

  it('storyboard 抛错只是没有截图，不影响字幕', async () => {
    const site = createFakeSite({
      harvest: async () => ({ lines: [line], source: 'dom', showTimestamps: true, failures: [] }),
    });
    site.storyboard = async () => {
      throw new Error('boom');
    };
    const session = createSession({ win: makeWin(), site });
    session.sync();
    await session.load();

    const state = session.store.getState();
    expect(state.status).toBe('ready');
    expect(state.storyboard).toBeNull();
    expect(state.lines).toHaveLength(1);
    session.dispose();
  });

  it('用户选了英文而站点只能给原文时，仍然把结果落成 ready（不假装是英文）', async () => {
    const site = createFakeSite({
      langs: ['zh-Hans'],
      harvest: async () => ({
        lines: [line],
        source: 'dom',
        showTimestamps: true,
        failures: [],
        track: { baseUrl: 'x', languageCode: 'zh-Hans', kind: 'manual' },
      }),
    });
    // langPlan 由站点自己算：没有 en 轨道时 tlang 应当为空
    expect(site.langPlan().tlang).toBeNull();

    const session = createSession({ win: makeWin(), site });
    session.sync();
    await session.load();
    expect(session.store.getState().status).toBe('ready');
    session.dispose();
  });
});
