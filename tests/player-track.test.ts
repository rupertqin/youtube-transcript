import { describe, expect, it, vi } from 'vitest';
import type { TimedTextCapture, TimedTextHook } from '../src/core/harvest/intercept';
import {
  captureWithCaptionSwitch,
  findCaptionTrack,
  readCurrentTrack,
} from '../src/core/harvest/player-track';

/**
 * A 方案：主动把播放器的 CC 轨道切到目标语言，截下播放器自己算好 POT 的 timedtext，
 * 然后立刻切回来。
 *
 * 注意 pot/signature 绑定 `(video, lang, kind)`，所以我们**必须**让播放器发这条请求，
 * 自己拼 URL 是拿不到数据的（改 lang → 404、加 tlang → 429）。
 */

const VIDEO = 'AAAAAAAAAAA';

const TRACKS = [
  { languageCode: 'ar', kind: 'asr', vssId: 'a.ar' },
  { languageCode: 'ja', kind: 'asr', vssId: 'a.ja' },
  { languageCode: 'ja', vssId: '.ja' }, // 手动轨道：同语言优先用它
  { languageCode: 'en', kind: 'asr', vssId: 'a.en' },
];

function captureOf(lang: string): TimedTextCapture {
  return {
    url: `https://www.youtube.com/api/timedtext?v=${VIDEO}&lang=${lang}&kind=asr&fmt=json3`,
    kind: 'timedtext',
    videoId: VIDEO,
    lang,
    text: '{"events":[]}',
    at: Date.now(),
  };
}

function fakePlayer(current: unknown = null) {
  const setOption = vi.fn();
  const player = {
    getOption: (module: string, option: string) => {
      if (module !== 'captions') return undefined;
      if (option === 'tracklist') return TRACKS;
      if (option === 'track') return current;
      return undefined;
    },
    setOption,
  };
  return { player, setOption };
}

function fakeWin(player: unknown, ccPressed = false) {
  const ccButton = { getAttribute: () => (ccPressed ? 'true' : 'false'), click: vi.fn() };
  const win = {
    document: {
      querySelector: (selector: string) => {
        if (selector === '#movie_player') return player;
        if (selector === '.ytp-subtitles-button') return ccButton;
        return null;
      },
    },
  } as unknown as Window;
  return { win, ccButton };
}

function fakeHook(capture: TimedTextCapture | null, waited = true): TimedTextHook {
  return {
    installedAt: 0,
    captures: () => (capture ? [capture] : []),
    latest: () => capture,
    waitFor: async () => (waited ? capture : null),
    waitForMatch: async () => (waited ? capture : null),
    onCapture: () => () => undefined,
    dispose: () => undefined,
  } as unknown as TimedTextHook;
}

describe('findCaptionTrack：只认目标语言，手动轨优先', () => {
  it('同一语言有多条时选手动轨（文本/时间轴都比 ASR 好）', () => {
    expect(findCaptionTrack(TRACKS, 'ja')?.vssId).toBe('.ja');
  });

  it('只有 ASR 时用它', () => {
    expect(findCaptionTrack(TRACKS, 'en')?.vssId).toBe('a.en');
  });

  it('没有该语言就返回 null（绝不拿别的语言顶）', () => {
    expect(findCaptionTrack(TRACKS, 'zh-Hans')).toBeNull();
  });

  it('主语言匹配也算（zh-Hant ↔ zh-Hans 之外的常见变体）', () => {
    const tracks = [{ languageCode: 'zh-Hant', kind: 'asr' }];
    expect(findCaptionTrack(tracks, 'zh-Hans')?.languageCode).toBe('zh-Hant');
  });
});

describe('readCurrentTrack', () => {
  it('轨道对象照原样读回；关着的时候是 null', () => {
    const { player } = fakePlayer({ languageCode: 'en', kind: 'asr' });
    expect(readCurrentTrack(player)?.languageCode).toBe('en');
    expect(readCurrentTrack(fakePlayer(null).player)).toBeNull();
  });
});

describe('captureWithCaptionSwitch：切轨 → 截获 → 还原', () => {
  it('切到目标轨道，截到目标语言的 timedtext', async () => {
    const { player, setOption } = fakePlayer(null);
    const { win } = fakeWin(player);

    const result = await captureWithCaptionSwitch({
      win,
      hook: fakeHook(captureOf('ja')),
      videoId: VIDEO,
      languageCode: 'ja',
      timeoutMs: 50,
    });

    expect(result.capture?.lang).toBe('ja');
    expect(setOption).toHaveBeenCalledWith(
      'captions',
      'track',
      expect.objectContaining({ languageCode: 'ja' }),
    );
  });

  it('原来 CC 关着 → 截完点 CC 按钮关回去（不留下字幕）', async () => {
    const { player } = fakePlayer(null);
    const { win, ccButton } = fakeWin(player, true);

    await captureWithCaptionSwitch({
      win,
      hook: fakeHook(captureOf('ja')),
      videoId: VIDEO,
      languageCode: 'ja',
      timeoutMs: 50,
    });

    expect(ccButton.click).toHaveBeenCalledTimes(1);
  });

  it('原来有轨道 → 切回原来那条，而不是关掉 CC', async () => {
    const previous = { languageCode: 'en', kind: 'asr' };
    const { player, setOption } = fakePlayer(previous);
    const { win, ccButton } = fakeWin(player, true);

    await captureWithCaptionSwitch({
      win,
      hook: fakeHook(captureOf('ja')),
      videoId: VIDEO,
      languageCode: 'ja',
      timeoutMs: 50,
    });

    // 第一次切到 ja，最后一次切回 en
    expect(setOption).toHaveBeenLastCalledWith('captions', 'track', previous);
    expect(ccButton.click).not.toHaveBeenCalled();
  });

  it('播放器没有该语言轨道时直接放弃，不动 CC', async () => {
    const { player, setOption } = fakePlayer(null);
    const { win } = fakeWin(player);

    const result = await captureWithCaptionSwitch({
      win,
      hook: fakeHook(captureOf('zh-Hans')),
      videoId: VIDEO,
      languageCode: 'zh-Hans',
      timeoutMs: 50,
    });

    expect(result.capture).toBeNull();
    expect(result.detail).toContain('没有 zh-Hans 轨道');
    expect(setOption).not.toHaveBeenCalled();
  });

  it('截到的是别的语言时不算成功（等待被语言过滤）', async () => {
    const { player } = fakePlayer(null);
    const { win } = fakeWin(player);

    const result = await captureWithCaptionSwitch({
      win,
      hook: fakeHook(captureOf('en')),
      videoId: VIDEO,
      languageCode: 'ja',
      timeoutMs: 50,
    });

    expect(result.capture).toBeNull();
    expect(result.detail).toContain('没截到');
  });
});
