import { describe, expect, it } from 'vitest';
import { createSession, type SessionHooks } from '../src/platform/session';
import type { TranscriptLine } from '../src/core/types';

/**
 * 端到端验证「合并真的接到了界面上」。
 *
 * 只测纯函数不够：用户看到的是 store.state.lines。如果某个宿主/缓存分支
 * 忘了调用 mergeFragments，纯函数的测试照样全绿，但字幕还是散的。
 */

function makeWin(id = 'AAAAAAAAAAA'): Window {
  const player = {
    getVideoData: () => ({ video_id: id }),
    getPlayerResponse: () => ({ videoDetails: { videoId: id, title: `title-${id}` } }),
  };
  const doc = {
    title: `title-${id} - YouTube`,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    querySelector: (selector: string) => (selector === '#movie_player' ? player : null),
    querySelectorAll: () => [],
  };
  return {
    document: doc,
    location: { href: `https://www.youtube.com/watch?v=${id}` },
    setInterval: (() => 0) as unknown as typeof setInterval,
    clearInterval: () => undefined,
    setTimeout: (() => 0) as unknown as typeof setTimeout,
    clearTimeout: () => undefined,
  } as unknown as Window;
}

/** endMs 重叠（盖到下一段之后）——正是让旧版合并整体失效的那种数据 */
const raw: TranscriptLine[] = [
  [0, 7_500, 'Welcome to The Daily Show.'],
  [6_000, 3_500, 'Let me tell you something.'],
  [8_000, 3_500, "I am so excited that you've joined us tonight."],
  [10_000, 2_500, 'My name is Jon Stewart.'],
  [11_000, 3_500, 'Unbelievable show for you tonight.'],
  [13_000, 3_500, 'Rachel Maddow is going to be joining us later.'],
  [15_000, 3_500, '[CHEERING, APPLAUSE]'],
  [20_000, 7_500, 'Jon Stewart and Rachel Maddow, liberal wet dream.'],
  [26_000, 3_500, 'I dreamed, I dreamed about this.'],
].map(([start, dur, text]) => ({ start: start as number, dur: dur as number, text: text as string }));

describe('会话层把 ASR 分段合并后再显示', () => {
  it('抓取结果落到 state.lines 时已是段落，诊断里能看出合并比例', async () => {
    const hooks: SessionHooks = {
      harvest: async () => ({
        lines: raw,
        source: 'innertube',
        showTimestamps: true,
        failures: [],
        complete: true,
      }),
      title: () => 'The Daily Show',
      storyboard: async () => null,
    };
    const session = createSession({ win: makeWin(), hooks });
    session.sync();
    await session.load();

    const state = session.store.getState();
    expect(state.status).toBe('ready');
    expect(state.lines).toHaveLength(4);
    expect(state.lines.map((l) => l.start)).toEqual([0, 8_000, 15_000, 20_000]);
    expect(state.mergeStats).toEqual({ raw: 9, merged: 4 });
    session.dispose();
  });
});
