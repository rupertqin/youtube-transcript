import { langMatches } from '../langs';
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
  videoDetails?: {
    videoId?: string;
    title?: string;
    lengthSeconds?: string | number;
    /** 视频默认音轨语言：原生字幕面板返回的就是这条轨道 */
    defaultAudioLanguage?: string;
  };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: RawTrack[];
      /** YouTube 允许机器翻译到的语言；有它才有「中/英」这类按钮的意义 */
      translationLanguages?: { languageCode?: string }[];
    };
  };
  playabilityStatus?: { status?: string; reason?: string };
  /** 章节缩略图（雪碧图）的规格串，见 core/storyboard.ts */
  storyboards?: {
    playerStoryboardSpecRenderer?: { spec?: string };
  };
}

/**
 * 取 storyboard 规格；拿不到就不显示章节截图，不影响其他功能。
 *
 * 传 expectedVideoId 时会校验这份 playerResponse 是否属于当前视频：
 * SPA 切页后播放器可能还挂着上一个视频的响应，用它取图会给新视频配旧画面。
 */
export function readStoryboardSpec(win: Window, expectedVideoId?: string): string | null {
  const response = readPlayerResponse(win);
  if (expectedVideoId) {
    const declared = response?.videoDetails?.videoId;
    if (declared && declared !== expectedVideoId) return null;
  }
  const spec = response?.storyboards?.playerStoryboardSpecRenderer?.spec;
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

/**
 * 当前**播放器**正在播的视频 id。
 *
 * readVideoId() 读的是地址栏：SPA 切页那一瞬间地址栏已经是新视频、
 * 播放器还停在旧视频上，此时读 DOM 拿到的是上一个视频的字幕行。
 * 抓取前必须用这个把两者对齐。
 *
 * 优先级刻意把 ytInitialPlayerResponse 放在最后：它是**首屏**注入的全局对象，
 * 切页后不会更新，当不了「当前视频」的判据。
 */
export function readPlayerVideoId(win: Window): string | null {
  const scope = win as unknown as {
    ytInitialPlayerResponse?: RawPlayerResponse;
    document: Document;
  };
  const doc = scope.document;

  const player = doc.querySelector('#movie_player') as
    | (Element & {
        getVideoData?: () => { video_id?: string; videoId?: string };
        getPlayerResponse?: () => RawPlayerResponse;
      })
    | null;

  try {
    const data = player?.getVideoData?.();
    const id = data?.video_id ?? data?.videoId;
    if (typeof id === 'string' && id) return id;
  } catch {
    /* 播放器未就绪 */
  }

  try {
    const id = player?.getPlayerResponse?.()?.videoDetails?.videoId;
    if (typeof id === 'string' && id) return id;
  } catch {
    /* ignore */
  }

  // SPA 切页后 YouTube 会同步更新这个属性，比全局 ytInitial 可靠
  const attr = doc.querySelector('ytd-watch-flexy')?.getAttribute('video-id');
  if (attr) return attr;

  const initial = scope.ytInitialPlayerResponse?.videoDetails?.videoId;
  return typeof initial === 'string' && initial ? initial : null;
}

/** 从地址解析 YouTube 视频 id（`?v=` 或 `/shorts/<id>`）。 */
export function videoIdFromHref(href: string): string | null {
  const url = new URL(href);
  const fromQuery = url.searchParams.get('v');
  if (fromQuery) return fromQuery;
  const shorts = /\/shorts\/([\w-]{6,})/u.exec(url.pathname);
  return shorts ? shorts[1] : null;
}

export function readVideoId(win: Window): string | null {
  return videoIdFromHref(win.location.href);
}

export function readTitle(win: Window, response?: RawPlayerResponse | null): string {
  const fromResponse = response?.videoDetails?.title;
  if (fromResponse) return fromResponse;
  return win.document.title.replace(/\s*-\s*YouTube\s*$/u, '');
}

/**
 * 当前视频总时长（秒）。读不到就返回 null。
 *
 * 用来做内容的**物理一致性**校验：字幕最后一条的时间点不可能超过视频时长。
 * 这条判据与 videoId 无关，因此能抓出「id 对得上、内容却是别的视频」的缓存条目
 * —— 那是单看 videoId 永远查不出来的。
 */
export function readVideoDuration(win: Window): number | null {
  const response = readPlayerResponse(win);
  const declared = Number(response?.videoDetails?.lengthSeconds);
  if (Number.isFinite(declared) && declared > 0) return declared;

  const video = win.document.querySelector('video') as HTMLVideoElement | null;
  const live = Number(video?.duration);
  if (Number.isFinite(live) && live > 0) return live;
  return null;
}

/**
 * 视频是否自带某种语言的原生字幕。
 *
 * 用来决定「要不要为了语言选择绕开拦截层 / DOM 层」：
 * 有原生轨道时，这两层拿到的就是目标语言，可以放心用；
 * 没有时它们只能给原文，必须先走能翻译的远程层，否则选了中文也会显示英文。
 */
export function hasNativeTrackFor(win: Window, lang: string): boolean {
  const tracks = readCaptionTracks(readPlayerResponse(win));
  return tracks.some((track) => langMatches(track.languageCode, lang));
}

/**
 * 这条视频**确实有**哪些语言的字幕。
 *
 * 只认原生 `captionTracks`，**不认 `translationLanguages`**。
 *
 * 曾经把「YouTube 声称能机翻到的语言」也算进来，结果按钮显示可点、点下去却
 * 拿不到对应语言的字幕（`tlang` 请求被签名/POT 挡掉，或服务器直接忽略 tlang
 * 返回原声轨道）。对用户来说这就是「按钮是假的」——所以这里只报能保证拿到的：
 * 视频自带的轨道。
 */
export function readAvailableLangs(win: Window, expectedVideoId?: string): string[] {
  const response = readPlayerResponse(win);
  // 切页瞬间播放器可能还挂着上一个视频的响应，那时报出来的语言是别人的
  const declared = response?.videoDetails?.videoId;
  if (expectedVideoId && declared && declared !== expectedVideoId) return [];
  const tracks = readCaptionTracks(response);
  const seen = new Set<string>();
  for (const track of tracks) {
    if (track.languageCode) seen.add(track.languageCode.toLowerCase());
  }
  return [...seen];
}

/**
 * 按 videoId 取标题。
 *
 * playerResponse 自带 videoDetails，既能给标题也能自证属于哪个视频；
 * 只有 id 对得上才用，否则退回 document.title。这样标题与字幕永远同源，
 * 不会出现「新字幕配旧标题」这种一眼就能看出错位的组合。
 */
export function readTitleFor(win: Window, videoId: string): string {
  const response = readPlayerResponse(win);
  if (response?.videoDetails?.videoId === videoId && response.videoDetails.title) {
    return response.videoDetails.title;
  }
  return readTitle(win);
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
