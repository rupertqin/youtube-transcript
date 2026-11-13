import { describe, expect, it } from 'vitest';
import { readVideoDuration } from '../src/core/harvest/player';
import { transcriptFitsDuration } from '../src/core/lines';
import type { TranscriptLine } from '../src/core/types';

/**
 * 「缓存里 id 对、内容却是别的视频」的自查。
 *
 * 这是本轮真正的病根：早期版本在 SPA 切页窗口期把上一个视频的 DOM 字幕
 * 按新视频的 videoId 写进缓存。之后每次打开那条视频都命中这份脏缓存，
 * 而 videoId 完全一致 —— 比 id 永远比不出来。
 *
 * 唯一可靠的判据是物理一致性：字幕最后一条不可能晚于视频结束。
 */

const line = (startMs: number): TranscriptLine => ({ start: startMs, dur: 0, text: 'x' });

describe('transcriptFitsDuration', () => {
  it('字幕末尾超出视频时长 → 判定不属于这条视频', () => {
    const lines = [line(0), line(120_000), line(3_000_000)];
    // 视频 10 分钟，字幕却排到 50 分钟：只可能是别的视频的
    expect(transcriptFitsDuration(lines, 600)).toBe(false);
  });

  it('字幕落在视频时长内 → 正常', () => {
    const lines = [line(0), line(120_000), line(540_000)];
    expect(transcriptFitsDuration(lines, 600)).toBe(true);
  });

  it('ASR 末条略微超出片长时留容差，不误杀', () => {
    const lines = [line(0), line(615_000)];
    expect(transcriptFitsDuration(lines, 600)).toBe(true);
  });

  it('读不到视频时长时不做判断（首屏 / 进广告都可能读不到）', () => {
    const lines = [line(0), line(9_999_999)];
    expect(transcriptFitsDuration(lines, null)).toBe(true);
    expect(transcriptFitsDuration(lines, 0)).toBe(true);
  });

  it('空字幕不判断', () => {
    expect(transcriptFitsDuration([], 600)).toBe(true);
  });
});

describe('readVideoDuration', () => {
  const makeWin = (response: unknown, liveDuration?: number): Window =>
    ({
      document: {
        querySelector: (selector: string) => {
          if (selector === '#movie_player') {
            return response ? { getPlayerResponse: () => response } : null;
          }
          if (selector === 'video') return liveDuration ? { duration: liveDuration } : null;
          return null;
        },
      },
    }) as unknown as Window;

  it('优先用 playerResponse 的 lengthSeconds', () => {
    expect(readVideoDuration(makeWin({ videoDetails: { videoId: 'A', lengthSeconds: '754' } }))).toBe(754);
  });

  it('playerResponse 没有时退回 video.duration', () => {
    expect(readVideoDuration(makeWin(null, 312.5))).toBe(312.5);
  });

  it('都读不到时返回 null', () => {
    expect(readVideoDuration(makeWin(null))).toBeNull();
  });
});
