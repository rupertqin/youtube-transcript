import { describe, expect, it, vi } from 'vitest';
import type { TimedTextCapture, TimedTextHook } from '../src/core/harvest/intercept';
import {
  captureWithCaptionSwitch,
  captureWithDefaultTrack,
  findCaptionTrack,
  interceptWithAutoSwitch,
  pickPlayerTrack,
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

function fakePlayer(current: unknown = null, tracks: unknown[] = TRACKS) {
  const setOption = vi.fn();
  const player = {
    getOption: (module: string, option: string) => {
      if (module !== 'captions') return undefined;
      if (option === 'tracklist') return tracks;
      if (option === 'track') return current;
      return undefined;
    },
    setOption,
  };
  return { player, setOption };
}

function fakeWin(player: unknown, ccPressed = false, extra: Record<string, unknown> = {}) {
  const ccButton = { getAttribute: () => (ccPressed ? 'true' : 'false'), click: vi.fn() };
  const win = {
    ...extra,
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

  it('播放器连一条轨道都没有时才放弃，不动 CC', async () => {
    const { player, setOption } = fakePlayer(null, []);
    const { win } = fakeWin(player);

    const result = await captureWithCaptionSwitch({
      win,
      hook: fakeHook(captureOf('zh-Hans')),
      videoId: VIDEO,
      languageCode: 'zh-Hans',
      timeoutMs: 50,
    });

    expect(result.capture).toBeNull();
    expect(result.detail).toContain('没有可用字幕轨道');
    expect(setOption).not.toHaveBeenCalled();
  });

  /**
   * 真实案例 K7Q6i3GW_ok：原声是中文，字幕轨只有一条 `en` ASR（YouTube 给的是翻译品）。
   * 用户选中文时不能直接报「没有 zh-Hans 轨道」—— 要让播放器自己发一条 tlang。
   */
  it('没有原生目标轨时改用播放器自动翻译（轨道带 translationLanguage）', async () => {
    const { player, setOption } = fakePlayer(null);
    const { win } = fakeWin(player);

    const result = await captureWithCaptionSwitch({
      win,
      hook: fakeHook(captureOf('zh-Hans')),
      videoId: VIDEO,
      languageCode: 'zh-Hans',
      langs: ['zh-Hans', 'zh-Hant', 'zh', 'en'],
      timeoutMs: 50,
    });

    expect(result.capture?.lang).toBe('zh-Hans');
    expect(setOption).toHaveBeenCalledWith(
      'captions',
      'track',
      expect.objectContaining({
        languageCode: 'en',
        translationLanguage: expect.objectContaining({ languageCode: 'zh-Hans' }),
      }),
    );
    expect(result.detail).toContain('自动翻译');
  });

  it('自动翻译没拿到时如实失败，绝不拿原文顶目标语言', async () => {
    const { player } = fakePlayer(null);
    const { win } = fakeWin(player);

    const result = await captureWithCaptionSwitch({
      win,
      hook: fakeHook(captureOf('en')),
      videoId: VIDEO,
      languageCode: 'zh-Hans',
      langs: ['zh-Hans', 'en'],
      timeoutMs: 50,
    });

    expect(result.capture).toBeNull();
    expect(result.detail).toContain('没截到');
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

describe('pickPlayerTrack：同音频模式按语言偏好挑一条', () => {
  it('优先语言列表里靠前的可用轨道', () => {
    expect(pickPlayerTrack(TRACKS, ['zh-Hans', 'en'])?.vssId).toBe('a.en');
  });

  it('同语言下手动轨优先（与抓取链的 pickTrack 同一套打分）', () => {
    expect(pickPlayerTrack(TRACKS, ['ja', 'en'])?.vssId).toBe('.ja');
  });

  it('没有语言码的轨道不参与；一条都没有就返回 null', () => {
    expect(pickPlayerTrack([{ kind: 'asr' }], ['en'])).toBeNull();
    expect(pickPlayerTrack([], ['en'])).toBeNull();
  });
});

const JSON3 = '{"events":[{"tStartMs":0,"dDurationMs":900,"segs":[{"utf8":"hi"}]}]}';

function json3Capture(lang: string): TimedTextCapture {
  return {
    url: `https://www.youtube.com/api/timedtext?v=${VIDEO}&lang=${lang}&kind=asr&fmt=json3`,
    kind: 'timedtext',
    videoId: VIDEO,
    lang,
    text: JSON3,
    at: Date.now(),
  };
}

/**
 * 真实案例 K7Q6i3GW_ok：只有一条 ASR 轨，页面上**没有 Show transcript**，
 * `get_panel` 回 200 但 0 段、裸请求 timedtext 是 200 + 空 body。
 * 唯一能拿到全文的路是让播放器自己发一次（带 POT），我们去截。
 */
describe('captureWithDefaultTrack：没有原生面板时借播放器发一次 timedtext', () => {
  it('挑出偏好轨道、切上去、截到后还原（原来 CC 关着就关回去）', async () => {
    const { player, setOption } = fakePlayer(null);
    const { win, ccButton } = fakeWin(player, true);

    const result = await captureWithDefaultTrack({
      win,
      hook: fakeHook(json3Capture('en')),
      videoId: VIDEO,
      langs: ['zh-Hans', 'en'],
      timeoutMs: 50,
    });

    expect(result.capture?.lang).toBe('en');
    expect(setOption).toHaveBeenCalledWith(
      'captions',
      'track',
      expect.objectContaining({ languageCode: 'en' }),
    );
    expect(ccButton.click).toHaveBeenCalledTimes(1);
  });

  it('一条轨道都没有时直接放弃，不动 CC', async () => {
    const { player, setOption } = fakePlayer(null, []);
    const { win } = fakeWin(player);

    const result = await captureWithDefaultTrack({
      win,
      hook: fakeHook(null),
      videoId: VIDEO,
      langs: ['en'],
      timeoutMs: 50,
    });

    expect(result.capture).toBeNull();
    expect(result.detail).toContain('没有可用字幕轨道');
    expect(setOption).not.toHaveBeenCalled();
  });

  it('只认切上去那条语言的响应（别的语言不算）', async () => {
    const { player } = fakePlayer(null);
    const { win } = fakeWin(player);

    const result = await captureWithDefaultTrack({
      win,
      hook: fakeHook(json3Capture('ja')),
      videoId: VIDEO,
      langs: ['en'],
      timeoutMs: 50,
    });

    expect(result.capture).toBeNull();
    expect(result.detail).toContain('没截到');
  });

  /**
   * MAIN world 里 `getOption('captions','tracklist')` 未必已就绪（播放器刚初始化，
   * 或这个构建只暴露了 setOption）。用户能看见字幕、我们却说「没有轨道」，
   * 就是这个空表造成的 —— 必须退回 playerResponse.captionTracks。
   */
  it('轨道表为空时退回 playerResponse.captionTracks，仍然能切', async () => {
    const { player, setOption } = fakePlayer(null, []);
    const { win } = fakeWin(player, false, {
      ytInitialPlayerResponse: {
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [
              {
                baseUrl: `https://www.youtube.com/api/timedtext?v=${VIDEO}&lang=en&kind=asr`,
                languageCode: 'en',
                kind: 'asr',
                vssId: 'a.en',
                isTranslatable: true,
              },
            ],
          },
        },
      },
    });

    const result = await captureWithDefaultTrack({
      win,
      hook: fakeHook(json3Capture('en')),
      videoId: VIDEO,
      langs: ['zh-Hans', 'en'],
      timeoutMs: 50,
    });

    expect(result.capture?.lang).toBe('en');
    expect(setOption).toHaveBeenCalledWith(
      'captions',
      'track',
      expect.objectContaining({ languageCode: 'en', vssId: 'a.en' }),
    );
  });
});

describe('interceptWithAutoSwitch（同音频）：面板拿不到东西时自动打开 CC 截一次', () => {
  const tracks = [{ languageCode: 'en', kind: 'asr', vssId: 'a.en' }];

  /** 切上轨道之后播放器才发 timedtext 的世界。 */
  function makeWorld(initial: TimedTextCapture | null = null) {
    // 与真实 hook 一致：捕获进历史就留着，还原 CC 不会把历史清掉
    const captures: TimedTextCapture[] = initial ? [initial] : [];
    const player = {
      getOption: (module: string, option: string) => {
        if (module !== 'captions') return undefined;
        if (option === 'tracklist') return tracks;
        return null;
      },
      setOption: vi.fn((module: string, option: string, value?: unknown) => {
        if (module !== 'captions' || option !== 'track') return;
        const code = (value as { languageCode?: string } | undefined)?.languageCode;
        if (!code) return;
        captures.unshift(json3Capture(code));
      }),
    };
    const { win } = fakeWin(player);
    const hook = {
      installedAt: 0,
      captures: () => [...captures],
      latest: () => captures[0] ?? null,
      waitFor: async () => captures[0] ?? null,
      waitForMatch: async () => captures[0] ?? null,
      onCapture: () => () => undefined,
      dispose: () => undefined,
    } as unknown as TimedTextHook;
    return { win, hook, player };
  }

  const ctxOf = () => ({
    videoId: VIDEO,
    langs: ['zh-Hans', 'en'],
    tlang: null,
    signal: new AbortController().signal,
    log: () => undefined,
  });

  it('手上没有捕获时切一次 CC，截到后能直接出字幕', async () => {
    const { win, hook, player } = makeWorld();

    const outcome = await interceptWithAutoSwitch({
      win,
      hook,
      ctx: ctxOf(),
      timeoutMs: 50,
      enabled: true,
    });

    expect(player.setOption).toHaveBeenCalled();
    expect(outcome?.lines).toHaveLength(1);
    expect(outcome?.lines[0].text).toBe('hi');
    expect(outcome?.complete).toBe(true);
  });

  it('已经有捕获（面板/播放器早先发过）时不再碰播放器', async () => {
    const { win, hook, player } = makeWorld(json3Capture('en'));

    const outcome = await interceptWithAutoSwitch({
      win,
      hook,
      ctx: ctxOf(),
      timeoutMs: 50,
      enabled: true,
    });

    expect(player.setOption).not.toHaveBeenCalled();
    expect(outcome?.lines).toHaveLength(1);
  });

  it('关掉「主动切轨」偏好时只等待，不动 CC', async () => {
    const { win, hook, player } = makeWorld();

    const outcome = await interceptWithAutoSwitch({
      win,
      hook,
      ctx: ctxOf(),
      timeoutMs: 20,
      enabled: false,
    });

    expect(player.setOption).not.toHaveBeenCalled();
    expect(outcome).toBeNull();
  });
});

/**
 * 用户反馈的完整场景（K7Q6i3GW_ok）：选了「中文」，视频只有一条 `en` ASR 轨
 * （原声是中文，YouTube 给的这条本身就是翻译品），页面上没有 Show transcript。
 * 播放器被设上 `translationLanguage` 后会发一条 `tlang=zh-Hans` 的 timedtext。
 */
describe('interceptWithAutoSwitch（指定中文）：没有中文原生轨时截播放器的翻译轨', () => {
  function makeWorld() {
    const captures: TimedTextCapture[] = [];
    const player = {
      getOption: (module: string, option: string) => {
        if (module !== 'captions') return undefined;
        if (option === 'tracklist') {
          return [{ languageCode: 'en', kind: 'asr', vssId: 'a.en', is_translateable: true }];
        }
        return null;
      },
      setOption: vi.fn((module: string, option: string, value?: unknown) => {
        if (module !== 'captions' || option !== 'track') return;
        const track = value as
          | { languageCode?: string; translationLanguage?: { languageCode?: string } }
          | undefined;
        const lang = track?.translationLanguage?.languageCode ?? track?.languageCode;
        if (!lang) return;
        // 播放器自己发的那条：翻译时 URL 上带 tlang（langFromTimedTextUrl 优先读它）
        const query = track?.translationLanguage
          ? `lang=en&tlang=${lang}`
          : `lang=${lang}`;
        captures.unshift({
          url: `https://www.youtube.com/api/timedtext?v=${VIDEO}&${query}&fmt=json3`,
          kind: 'timedtext',
          videoId: VIDEO,
          lang,
          text: JSON3,
          at: Date.now(),
        });
      }),
    };
    const { win } = fakeWin(player);
    const hook = {
      installedAt: 0,
      captures: () => [...captures],
      latest: () => captures[0] ?? null,
      waitFor: async () => captures[0] ?? null,
      waitForMatch: async () => captures[0] ?? null,
      onCapture: () => () => undefined,
      dispose: () => undefined,
    } as unknown as TimedTextHook;
    return { win, hook, player };
  }

  it('切到 en 并要求翻译成中文，截到的就是中文轨', async () => {
    const { win, hook, player } = makeWorld();

    const outcome = await interceptWithAutoSwitch({
      win,
      hook,
      ctx: {
        videoId: VIDEO,
        langs: ['zh-Hans', 'zh-Hant', 'zh', 'zh-CN', 'zh-TW', 'en'],
        tlang: 'zh-Hans',
        signal: new AbortController().signal,
        log: () => undefined,
      },
      timeoutMs: 50,
      enabled: true,
    });

    expect(player.setOption).toHaveBeenCalledWith(
      'captions',
      'track',
      expect.objectContaining({
        languageCode: 'en',
        translationLanguage: expect.objectContaining({ languageCode: 'zh-Hans' }),
      }),
    );
    expect(outcome?.lines).toHaveLength(1);
    // 语言码取 tlang：缓存/语言徽标都要是真正拿到的中文，而不是源轨的 en
    expect(outcome?.track?.languageCode).toBe('zh-Hans');
  });

  /**
   * 切轨失败的原因必须进 `failures[]`（面板诊断）。
   *
   * 以前只 `ctx.log` 到 console：诊断里只剩 `runInterceptSource` 那句
   * 「捕获的是 en，不是要的 zh-Hans」，看起来像我们压根没尝试切轨 ——
   * 真实原因（轨道表为空 / 播放器 API 不可用 / 切了但没截到）全丢了。
   */
  it('切轨失败时把原因写进 failures，而不是只打 console', async () => {
    const player = {
      getOption: (module: string, option: string) =>
        module === 'captions' && option === 'tracklist' ? [{ languageCode: 'en', kind: 'asr' }] : null,
      setOption: vi.fn(), // 切了，但播放器一条请求都不发
    };
    const { win } = fakeWin(player);
    const hook = {
      installedAt: 0,
      captures: () => [],
      latest: () => null,
      waitFor: async () => null,
      waitForMatch: async () => null,
      onCapture: () => () => undefined,
      dispose: () => undefined,
    } as unknown as TimedTextHook;

    const outcome = await interceptWithAutoSwitch({
      win,
      hook,
      ctx: {
        videoId: VIDEO,
        langs: ['zh-Hans', 'en'],
        tlang: 'zh-Hans',
        signal: new AbortController().signal,
        log: () => undefined,
      },
      timeoutMs: 20,
      enabled: true,
    });

    expect(outcome?.lines).toHaveLength(0);
    const detail = outcome?.failures?.[0]?.detail ?? '';
    expect(detail).toContain('切轨失败');
    // 要能看出走的是「自动翻译」而不是「没有这条轨道」
    expect(detail).toContain('自动翻译');
  });
});
