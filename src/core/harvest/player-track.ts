import { langMatches } from '../langs';
import type { SourceOutcome } from '../types';
import type { TimedTextCapture, TimedTextHook } from './intercept';
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
 * `waitForMatch` 只认目标语言的捕获，所以 YouTube 在切之前补发的那条原语言响应
 * 不会把结果顶掉。
 */
export async function captureWithCaptionSwitch(options: {
  win: Window;
  hook: TimedTextHook;
  videoId: string;
  languageCode: string;
  timeoutMs: number;
}): Promise<AutoSwitchResult> {
  const { win, hook, videoId, languageCode } = options;
  const player = readCaptionPlayer(win);
  if (!player?.setOption) {
    return { capture: null, detail: '播放器 API 不可用（拿不到 #movie_player.setOption）' };
  }

  const tracks = readCaptionTracks(player);
  const wanted = findCaptionTrack(tracks, languageCode);
  if (!wanted) {
    const have = tracks.map((track) => track.languageCode).filter(Boolean).join('/');
    return { capture: null, detail: `播放器没有 ${languageCode} 轨道（现有：${have || '无'}）` };
  }

  const previous = readCurrentTrack(player);
  try {
    player.setOption('captions', 'track', wanted);
  } catch (error) {
    return { capture: null, detail: `切到 ${languageCode} 失败：${String(error)}` };
  }

  try {
    const capture = hook.waitForMatch
      ? await hook
          .waitForMatch(videoId, (item) => langMatches(item.lang, languageCode), options.timeoutMs)
          .catch(() => null)
      : await hook.waitFor(videoId, options.timeoutMs).catch(() => null);

    const ok = capture && langMatches(capture.lang, languageCode) ? capture : null;
    return {
      capture: ok,
      detail: ok
        ? `已切到 ${languageCode} 并截到 timedtext（${ok.text.length} 字符）`
        : `切到 ${languageCode} 后 ${options.timeoutMs}ms 内没截到 timedtext`,
    };
  } finally {
    restoreCaptions(win, player, previous);
  }
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

  // 只有「指定了产出语言」时才值得切轨：同音频模式下面板/最新捕获就够
  if (!options.enabled || !ctx.tlang) {
    return runInterceptSource(ctx, hook, timeoutMs) ?? ready;
  }

  const switched = await captureWithCaptionSwitch({
    win,
    hook,
    videoId: ctx.videoId,
    languageCode: ctx.tlang,
    timeoutMs: Math.max(timeoutMs, 1_500),
  });
  ctx.log({
    code: switched.capture ? 'OK' : 'NO_CAPTION_TRACK',
    source: 'intercept',
    detail: switched.detail,
  });
  if (!switched.capture) return ready;

  const captured = await runInterceptSource(ctx, hook, 0);
  return captured && captured.lines.length > 0 ? captured : (ready ?? captured);
}
