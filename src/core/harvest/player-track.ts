import { langMatches } from '../langs';
import type { SourceOutcome } from '../types';
import type { TimedTextCapture, TimedTextHook } from './intercept';
import { readCaptionTracks as readResponseTracks, readPlayerResponse } from './player';
import { runInterceptSource } from './sources';

/**
 * A 方案：**主动**让播放器以目标语言发一次 timedtext。
 *
 * 为什么必须借播放器：timedtext 的 `signature` 和 `pot` 都是播放器算的，
 * 且绑定 `(video, lang, kind)`（实测改 lang → 404、加 tlang → 429、换 v → 404）。
 * 我们只能截播放器自己发的那条，没法自己拼。
 *
 * 代价：要把 CC 切到目标轨道（字幕会短暂出现在画面上），截完立刻还原。
 * 所以整条路径由 `prefs.autoSwitchTrack` 控制，只作为 B（用户手动切一次）的自动化补充。
 */

interface CaptionTrackLike {
  languageCode?: string;
  kind?: string;
  vssId?: string;
  name?: unknown;
  /** 播放器轨道表里的字段名就是这么拼的（内部 API 的老拼写） */
  is_translateable?: boolean;
  isTranslatable?: boolean;
  /**
   * 播放器的机器翻译设置：带上它，播放器会自己发一条 `tlang=` 的 timedtext。
   *
   * 这条是**唯一**能拿到翻译轨的路：`tlang` 与 `signature`/`pot` 绑定
   * （实测自己拼 `tlang` → 429、改 `lang` → 404），只有播放器现算的那条有效。
   */
  translationLanguage?: { languageCode?: string; languageName?: string };
}

interface CaptionPlayer {
  getOption?: (module: string, option: string) => unknown;
  setOption?: (module: string, option: string, value?: unknown) => unknown;
}

export interface AutoSwitchResult {
  capture: TimedTextCapture | null;
  /** 一句话诊断：切了没切、截到没截到、为什么 */
  detail: string;
}

/** `#movie_player` 上的轨道 API（只有 MAIN world / 页面上下文能调）。 */
export function readCaptionPlayer(win: Window): CaptionPlayer | null {
  try {
    const node = win.document?.querySelector('#movie_player') as (HTMLElement & CaptionPlayer) | null;
    if (!node) return null;
    const usable = typeof node.getOption === 'function' || typeof node.setOption === 'function';
    return usable ? node : null;
  } catch {
    return null;
  }
}

export function readCaptionTracks(player: CaptionPlayer): CaptionTrackLike[] {
  try {
    const list = player.getOption?.('captions', 'tracklist');
    return Array.isArray(list) ? (list as CaptionTrackLike[]) : [];
  } catch {
    return [];
  }
}

export function readCurrentTrack(player: CaptionPlayer): CaptionTrackLike | null {
  try {
    const track = player.getOption?.('captions', 'track');
    return track && typeof track === 'object' ? (track as CaptionTrackLike) : null;
  } catch {
    return null;
  }
}

/**
 * 轨道表为空时的兜底：用 `playerResponse.captionTracks` 拼出同样形状的轨道对象。
 *
 * MAIN world 里 `getOption('captions','tracklist')` 未必已经就绪（播放器刚初始化、
 * 或者这个构建只暴露了 `setOption`），而 `setOption` 能吃下同样形状的对象。
 * 少了这一步，最后一次机会会被静默丢掉 —— 诊断里只剩一句「没有可用字幕轨道」，
 * 用户能看见字幕、我们却说没有。
 */
function tracksFromResponse(win: Window): CaptionTrackLike[] {
  return readResponseTracks(readPlayerResponse(win)).map((track) => ({
    languageCode: track.languageCode,
    kind: track.kind,
    vssId: track.vssId,
    name: track.name,
    is_translateable: track.isTranslatable,
  }));
}

/** 播放器轨道表优先；空表时退回播放器响应里的轨道。 */
function usableTracks(win: Window, player: CaptionPlayer): CaptionTrackLike[] {
  const fromPlayer = readCaptionTracks(player);
  return fromPlayer.length > 0 ? fromPlayer : tracksFromResponse(win);
}

/**
 * 在轨道表里找目标语言。
 *
 * 同语言有多条时优先**手动轨道**（`kind` 为空）—— 它的断句与文本质量都比 ASR 好，
 * 时间轴也更准。找不到就返回 null（绝不拿别的语言顶）。
 */
export function findCaptionTrack(
  tracks: readonly CaptionTrackLike[],
  languageCode: string,
): CaptionTrackLike | null {
  const same = tracks.filter((track) => langMatches(track.languageCode, languageCode));
  if (same.length === 0) return null;
  return same.find((track) => track.kind !== 'asr') ?? same[0];
}

function trackScore(track: CaptionTrackLike, langs: readonly string[]): number {
  let value = 100;
  const code = (track.languageCode ?? '').toLowerCase();
  const index = langs.findIndex((lang) => {
    const base = lang.split('-')[0].toLowerCase();
    return code === lang.toLowerCase() || code === base || code.startsWith(`${base}-`);
  });
  if (index >= 0) value = index * 10;
  if (track.kind !== 'asr') value -= 5;
  return value;
}

/**
 * 「同音频」模式（用户没指定产出语言）下挑哪条轨道。
 *
 * 和抓取链的 `pickTrack()` 同一套打分：语言偏好顺序优先，同语言下手动轨优先。
 * 没有语言码的轨道不参与 —— 不知道语言就无法判断它是不是用户要的。
 */
export function pickPlayerTrack(
  tracks: readonly CaptionTrackLike[],
  langs: readonly string[],
): CaptionTrackLike | null {
  const usable = tracks.filter((track) => Boolean(track?.languageCode));
  if (usable.length === 0) return null;
  return [...usable].sort((a, b) => trackScore(a, langs) - trackScore(b, langs))[0];
}

/** 还原现场：原来是关的就点一下 CC 按钮关掉，原来有轨道就切回去。 */
function restoreCaptions(
  win: Window,
  player: CaptionPlayer,
  previous: CaptionTrackLike | null,
): void {
  try {
    if (previous) {
      player.setOption?.('captions', 'track', previous);
      return;
    }
    // 原来是关的：setOption 没有「关闭」语义，只能点 CC 按钮把它关掉
    const button = win.document?.querySelector('.ytp-subtitles-button') as HTMLElement | null;
    if (button?.getAttribute('aria-pressed') === 'true') {
      button.click();
      return;
    }
    player.setOption?.('captions', 'track', {});
  } catch {
    /* 还原失败不影响抓取结果 */
  }
}

/**
 * 切一次轨道 → 等带 POT 的 timedtext → 立刻还原。
 *
 * `accept` 只认这条轨道产出的响应，所以 YouTube 在切之前补发的那条原语言响应
 * 不会把结果顶掉。
 */
async function switchToTrackAndWait(options: {
  win: Window;
  hook: TimedTextHook;
  player: CaptionPlayer;
  videoId: string;
  track: CaptionTrackLike;
  accept: (capture: TimedTextCapture) => boolean;
  timeoutMs: number;
  /** 诊断/日志里怎么称呼这条轨道 */
  describe: string;
}): Promise<AutoSwitchResult> {
  const { win, hook, player, videoId, track, accept, timeoutMs, describe } = options;

  const previous = readCurrentTrack(player);
  try {
    player.setOption?.('captions', 'track', track);
  } catch (error) {
    return { capture: null, detail: `切到 ${describe} 失败：${String(error)}` };
  }

  try {
    const capture = hook.waitForMatch
      ? await hook.waitForMatch(videoId, accept, timeoutMs).catch(() => null)
      : await hook.waitFor(videoId, timeoutMs).catch(() => null);

    const ok = capture && accept(capture) ? capture : null;
    return {
      capture: ok,
      detail: ok
        ? `已切到 ${describe} 并截到 timedtext（${ok.text.length} 字符）`
        : `切到 ${describe} 后 ${timeoutMs}ms 内没截到 timedtext`,
    };
  } finally {
    restoreCaptions(win, player, previous);
  }
}

/**
 * 指定产出语言：切到目标轨道，截下播放器自己算好 POT 的 timedtext，然后还原。
 *
 * 目标语言**没有原生轨道**时不放弃：改走播放器自己的「自动翻译」
 * （轨道对象带 `translationLanguage`），它发出的那条 timedtext 带 `tlang=`，
 * 语言码正好是产出语言。
 *
 * 真实案例 `K7Q6i3GW_ok`：原声是中文，字幕轨只有一条 `en` ASR（YouTube 给的
 * 是翻译品），用户选中文时以前会在 7ms 内直接报「播放器没有 zh-Hans 轨道」。
 */
export async function captureWithCaptionSwitch(options: {
  win: Window;
  hook: TimedTextHook;
  videoId: string;
  languageCode: string;
  timeoutMs: number;
  /** 挑「翻译源轨道」用的语言偏好（一般就是本次的 `plan.langs`） */
  langs?: readonly string[];
}): Promise<AutoSwitchResult> {
  const { win, hook, videoId, languageCode } = options;
  const player = readCaptionPlayer(win);
  if (!player?.setOption) {
    return { capture: null, detail: '播放器 API 不可用（拿不到 #movie_player.setOption）' };
  }

  const tracks = usableTracks(win, player);
  const have = tracks.map((track) => track.languageCode).filter(Boolean).join('/');

  const native = findCaptionTrack(tracks, languageCode);
  if (native) {
    return switchToTrackAndWait({
      win,
      hook,
      player,
      videoId,
      track: native,
      accept: (item) => langMatches(item.lang, languageCode),
      timeoutMs: options.timeoutMs,
      describe: languageCode,
    });
  }

  const base = pickPlayerTrack(tracks, options.langs ?? []);
  if (!base?.languageCode) {
    return { capture: null, detail: `播放器没有可用字幕轨道（现有：${have || '无'}）` };
  }

  // 轨道标了「不可翻译」也照试：这个字段来自内部 API，拼写/取值都不稳，
  // 拿它当硬闸门会把最后一条路也堵掉。真翻译不了就是等 1.5s 超时，
  // 代价远小于「明明有字幕却报没有」。
  const translateable = base.is_translateable ?? base.isTranslatable;
  return switchToTrackAndWait({
    win,
    hook,
    player,
    videoId,
    track: {
      ...base,
      translationLanguage: { languageCode, languageName: languageCode },
    },
    accept: (item) => langMatches(item.lang, languageCode),
    timeoutMs: options.timeoutMs,
    describe: `${base.languageCode}→${languageCode}（自动翻译${translateable === false ? '，轨道标了不可翻译' : ''}）`,
  });
}

/**
 * 同音频模式的兜底：**页面没有原生字幕面板**时借播放器发一次 timedtext。
 *
 * 真实案例 `K7Q6i3GW_ok`（只有一条 ASR 轨、`ytInitialData` 里连
 * `engagement-panel-searchable-transcript` 都没有）：`get_panel` 回
 * 200 但 0 段，裸请求 timedtext 是 200 + 空 body（POT 生效），
 * 页面上也没有面板可截。播放器自己切上去的那条请求带 POT，是唯一能拿到全文的路。
 *
 * 代价同 A 方案：字幕会在画面上短暂出现，截完立刻还原。
 */
export async function captureWithDefaultTrack(options: {
  win: Window;
  hook: TimedTextHook;
  videoId: string;
  langs: readonly string[];
  timeoutMs: number;
}): Promise<AutoSwitchResult> {
  const { win, hook, videoId } = options;
  const player = readCaptionPlayer(win);
  if (!player?.setOption) {
    return { capture: null, detail: '播放器 API 不可用（拿不到 #movie_player.setOption）' };
  }

  const tracks = usableTracks(win, player);
  const wanted = pickPlayerTrack(tracks, options.langs ?? []);
  const code = wanted?.languageCode;
  if (!wanted || !code) {
    const have = tracks.map((track) => track.languageCode).filter(Boolean).join('/');
    return { capture: null, detail: `播放器没有可用字幕轨道（现有：${have || '无'}）` };
  }

  return switchToTrackAndWait({
    win,
    hook,
    player,
    videoId,
    track: wanted,
    accept: (item) => langMatches(item.lang, code),
    timeoutMs: options.timeoutMs,
    describe: code,
  });
}

/**
 * 切轨失败时把原因**写进 failures**。
 *
 * 以前只 `ctx.log` 到 console，面板诊断里只剩 `runInterceptSource` 那句
 * 「捕获的是 en，不是要的 zh-Hans」，看起来像「我们压根没试」；
 * 真正的原因（轨道表为空 / 播放器 API 不可用 / 切了但没截到）全丢了。
 */
function switchFailure(detail: string): SourceOutcome {
  return {
    lines: [],
    source: 'intercept',
    showTimestamps: true,
    failures: [{ source: 'intercept', code: 'NO_CAPTION_TRACK', ms: 0, detail }],
  };
}

/**
 * 拦截层 + 自动切轨：先看手上有没有（0ms），没有就切一次轨道再截。
 *
 * B 的自动化补充，顺序刻意是「先白嫖已有的捕获」—— 用户手动切过一次的话，
 * 这里连播放器都不会碰。
 */
export async function interceptWithAutoSwitch(options: {
  win: Window;
  hook: TimedTextHook;
  ctx: Parameters<typeof runInterceptSource>[0];
  timeoutMs: number;
  enabled: boolean;
}): Promise<SourceOutcome | null> {
  const { win, hook, ctx, timeoutMs } = options;

  const ready = await runInterceptSource(ctx, hook, 0);
  if (ready && ready.lines.length > 0) return ready;

  if (!options.enabled) {
    return runInterceptSource(ctx, hook, timeoutMs) ?? ready;
  }

  // 指定了产出语言：切到目标轨道（没有原生轨时改用播放器自动翻译）
  if (ctx.tlang) {
    const switched = await captureWithCaptionSwitch({
      win,
      hook,
      videoId: ctx.videoId,
      languageCode: ctx.tlang,
      langs: ctx.langs,
      timeoutMs: Math.max(timeoutMs, 1_500),
    });
    ctx.log({
      code: switched.capture ? 'OK' : 'NO_CAPTION_TRACK',
      source: 'intercept',
      detail: switched.detail,
    });
    if (!switched.capture) return switchFailure(`切轨失败：${switched.detail}`);

    const captured = await runInterceptSource(ctx, hook, 0);
    return captured && captured.lines.length > 0 ? captured : (ready ?? captured);
  }

  // 同音频：先短等一下页面自己发出的请求 —— 原生面板能用的视频到这里就够了，
  // 不碰 CC、画面上不会闪字幕。
  const waited = await runInterceptSource(ctx, hook, Math.min(timeoutMs, 900));
  if (waited && waited.lines.length > 0) return waited;

  // 等不到就是「这条视频没有原生字幕面板」（只有 ASR 轨的新闻/直播回放类很常见）。
  // 这时只剩播放器那条路：打开它已有的一条轨道，截下带 POT 的 timedtext。
  const switched = await captureWithDefaultTrack({
    win,
    hook,
    videoId: ctx.videoId,
    langs: ctx.langs,
    timeoutMs: Math.max(timeoutMs, 1_500),
  });
  ctx.log({
    code: switched.capture ? 'OK' : 'NO_CAPTION_TRACK',
    source: 'intercept',
    detail: switched.detail,
  });
  if (!switched.capture) return switchFailure(`切轨失败：${switched.detail}`);

  const captured = await runInterceptSource(ctx, hook, 0);
  return captured && captured.lines.length > 0 ? captured : (ready ?? waited ?? captured);
}
