import type { TranscriptLine } from '../../types';
import type { BiliTrack } from './parse';

/**
 * 页面内的兜底数据源（不打任何接口）。
 *
 * B 站把首屏数据塞在 `window.__INITIAL_STATE__` 里，`videoData.subtitle.list`
 * 直接带着每条轨道的 `subtitle_url` —— 也就是**不用 WBI 签名**也能下到字幕。
 * 它是接口失败时的正经退路，不是「随便读点字」：
 * 有 URL 就有时轴，`complete: true`，可以正常进缓存。
 */
interface BiliInitialState {
  bvid?: string;
  aid?: number;
  cid?: number;
  videoData?: {
    bvid?: string;
    cid?: number;
    title?: string;
    duration?: number;
    pages?: Array<{ cid?: number; page?: number; part?: string }>;
    subtitle?: { list?: BiliTrack[] };
  };
}

export interface BiliPageSnapshot {
  bvid: string;
  cid: number | null;
  title: string | null;
  duration: number | null;
  tracks: BiliTrack[];
}

function initialState(win: Window): BiliInitialState | null {
  try {
    const state = (win as unknown as { __INITIAL_STATE__?: BiliInitialState }).__INITIAL_STATE__;
    return state && typeof state === 'object' ? state : null;
  } catch {
    return null;
  }
}

/** 首屏状态里的可用信息；没有 __INITIAL_STATE__ 时返回 null。 */
export function readBiliPageState(win: Window): BiliPageSnapshot | null {
  const state = initialState(win);
  if (!state) return null;
  const video = state.videoData;
  const bvid = video?.bvid ?? state.bvid;
  if (!bvid) return null;

  const tracks = (video?.subtitle?.list ?? []).filter(
    (track) => typeof track?.subtitle_url === 'string' && track.subtitle_url.length > 0,
  );

  return {
    bvid,
    cid: Number(video?.cid ?? state.cid) || null,
    title: video?.title ?? null,
    duration: Number(video?.duration) || null,
    tracks,
  };
}

/** 首屏状态里当前分 P 的 cid（页面没给 pages 时退回主 cid）。 */
export function readBiliPageCid(win: Window, page: number): number | null {
  const state = initialState(win);
  const video = state?.videoData;
  const pages = video?.pages ?? [];
  const hit = pages.find((item) => Number(item.page) === page);
  return Number(hit?.cid ?? video?.cid ?? state?.cid) || null;
}

export interface RenderedSubtitle {
  lines: TranscriptLine[];
  showTimestamps: boolean;
}

/**
 * 播放器**已经加载**的字幕轨（`video.textTracks` 的 cues）。
 *
 * B 站主流播放器是自己画字幕，`textTracks` 常常是空的 —— 所以这只是一个
 * 尽力而为的最后退路；拿不到就返回 null，由调用方报「没有字幕」而不是瞎猜。
 */
export function readRenderedSubtitle(win: Window): RenderedSubtitle | null {
  const video = win.document?.querySelector('video') as HTMLVideoElement | null;
  const tracks = video?.textTracks;
  if (!tracks || tracks.length === 0) return null;

  for (let index = 0; index < tracks.length; index += 1) {
    const track = tracks[index];
    const cues = track?.cues;
    if (!cues || cues.length === 0) continue;
    const lines: TranscriptLine[] = [];
    for (let cueIndex = 0; cueIndex < cues.length; cueIndex += 1) {
      const cue = cues[cueIndex] as VTTCue | null;
      const text = String(cue?.text ?? '')
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!text) continue;
      const startTime = cue?.startTime ?? 0;
      const endTime = cue?.endTime ?? startTime;
      lines.push({
        start: Math.max(0, Math.round(startTime * 1000)),
        dur: Math.max(0, Math.round((endTime - startTime) * 1000)),
        text,
      });
    }
    if (lines.length > 0) return { lines, showTimestamps: true };
  }
  return null;
}
