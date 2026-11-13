import type { CaptionTrack, ErrorCode } from '../types';

/* 只读类型声明，避免把整个 player 的 any 扩散出去 */
interface RawTrack {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
  vssId?: string;
  isTranslatable?: boolean;
  name?: { simpleText?: string; runs?: { text?: string }[] };
}

interface RawPlayerResponse {
  videoDetails?: { videoId?: string; title?: string };
  captions?: {
    playerCaptionsTracklistRenderer?: { captionTracks?: RawTrack[] };
  };
  playabilityStatus?: { status?: string; reason?: string };
  /** 章节缩略图（雪碧图）的规格串，见 core/storyboard.ts */
  storyboards?: {
    playerStoryboardSpecRenderer?: { spec?: string };
  };
}

/** 取 storyboard 规格；拿不到就不显示章节截图，不影响其他功能。 */
export function readStoryboardSpec(win: Window): string | null {
  const spec = readPlayerResponse(win)?.storyboards?.playerStoryboardSpecRenderer?.spec;
  return typeof spec === 'string' && spec.includes('|') ? spec : null;
}

/** 播放器实例上取 playerResponse；某些环境取不到时回落到首屏注入的全局对象。 */
export function readPlayerResponse(win: Window): RawPlayerResponse | null {
  const scope = win as unknown as {
    ytInitialPlayerResponse?: RawPlayerResponse;
    document: Document;
  };

  const player = scope.document.querySelector('#movie_player') as
    | (Element & { getPlayerResponse?: () => RawPlayerResponse })
    | null;

  try {
    const fromPlayer = player?.getPlayerResponse?.();
    if (fromPlayer && typeof fromPlayer === 'object') return fromPlayer;
  } catch {
    /* 播放器未就绪 */
  }

  if (scope.ytInitialPlayerResponse) return scope.ytInitialPlayerResponse;
  return null;
}

export function readVideoId(win: Window): string | null {
  const url = new URL(win.location.href);
  const fromQuery = url.searchParams.get('v');
  if (fromQuery) return fromQuery;
  const shorts = /\/shorts\/([\w-]{6,})/u.exec(url.pathname);
  return shorts ? shorts[1] : null;
}

export function readTitle(win: Window, response?: RawPlayerResponse | null): string {
  const fromResponse = response?.videoDetails?.title;
  if (fromResponse) return fromResponse;
  return win.document.title.replace(/\s*-\s*YouTube\s*$/u, '');
}

function trackName(track: RawTrack): string | undefined {
  if (!track.name) return undefined;
  if (track.name.simpleText) return track.name.simpleText;
  if (Array.isArray(track.name.runs)) {
    return track.name.runs.map((run) => run.text ?? '').join('') || undefined;
  }
  return undefined;
}

export function readCaptionTracks(response: RawPlayerResponse | null): CaptionTrack[] {
  const raw = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((track): track is RawTrack & { baseUrl: string } => Boolean(track?.baseUrl))
    .map((track) => ({
      baseUrl: track.baseUrl,
      languageCode: track.languageCode ?? 'unknown',
      kind: track.kind,
      vssId: track.vssId,
      isTranslatable: track.isTranslatable,
      name: trackName(track),
    }));
}

/** 播放器侧的受限原因，用于把「没字幕」和「看不了」区分开。 */
export function describePlayability(
  response: RawPlayerResponse | null,
): { code: ErrorCode; detail: string } | null {
  const status = response?.playabilityStatus?.status;
  if (!status || status === 'OK') return null;
  const reason = response?.playabilityStatus?.reason ?? status;
  if (/age|inappropriate|sign in to confirm your age/iu.test(reason)) {
    return { code: 'AGE_RESTRICTED', detail: reason };
  }
  if (status === 'LOGIN_REQUIRED') return { code: 'AGE_RESTRICTED', detail: reason };
  if (status === 'ERROR') return { code: 'NO_CAPTION_TRACK', detail: reason };
  return { code: 'NO_CAPTION_TRACK', detail: `${status}: ${reason}` };
}

/**
 * 轨道选择：语言偏好优先，同语言下手动字幕优先于 ASR。
 */
export function pickTrack(tracks: CaptionTrack[], langs: string[]): CaptionTrack | null {
  if (tracks.length === 0) return null;

  const score = (track: CaptionTrack): number => {
    let value = 100;
    const index = langs.findIndex((lang) => {
      const base = lang.split('-')[0].toLowerCase();
      const code = track.languageCode.toLowerCase();
      return code === lang.toLowerCase() || code === base || code.startsWith(`${base}-`);
    });
    if (index >= 0) value = index * 10;
    if (track.kind !== 'asr') value -= 5;
    return value;
  };

  return [...tracks].sort((a, b) => score(a) - score(b))[0];
}

export interface InnertubeConfig {
  key?: string;
  clientVersion: string;
  visitorData?: string;
}

/** InnerTube 兜底需要页面自己的 API key / client 版本，只在 MAIN world 或页面上下文能拿到。 */
export function readInnertubeConfig(win: Window): InnertubeConfig {
  const scope = win as unknown as {
    ytcfg?: { get?: (key: string) => unknown; data_?: Record<string, unknown> };
  };
  const read = (key: string): string | undefined => {
    try {
      const value = scope.ytcfg?.get?.(key);
      if (typeof value === 'string' && value) return value;
    } catch {
      /* ignore */
    }
    const fallback = scope.ytcfg?.data_?.[key];
    return typeof fallback === 'string' ? fallback : undefined;
  };

  return {
    key: read('INNERTUBE_API_KEY'),
    clientVersion: read('INNERTUBE_CLIENT_VERSION') ?? '2.20240101.00.00',
    visitorData: read('VISITOR_DATA'),
  };
}
